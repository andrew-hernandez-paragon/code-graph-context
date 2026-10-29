"""
Local embedding server for code-graph-context.
Uses Qwen3-Embedding-0.6B for high-quality code embeddings without OpenAI dependency.
Runs as a sidecar process managed by the Node.js MCP server.
"""

import gc
import os
import sys
import signal
import logging
import threading
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("embedding-sidecar")

logger.info(f"Sidecar process starting (pid={os.getpid()})")

app = FastAPI(title="code-graph-context embedding sidecar")

model = None
last_embed_at = time.monotonic()
model_name = os.environ.get("EMBEDDING_MODEL", "").strip() or "BAAI/bge-base-en-v1.5"


class EmbedRequest(BaseModel):
    texts: list[str]
    batch_size: int = 8


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dimensions: int
    model: str


@app.on_event("startup")
def load_model():
    global model
    try:
        import torch
        from sentence_transformers import SentenceTransformer

        # Patch: CodeSage imports Conv1D from transformers.modeling_utils but it
        # was moved to transformers.pytorch_utils. Re-export it if missing.
        import transformers.modeling_utils
        if not hasattr(transformers.modeling_utils, 'Conv1D'):
            from transformers.pytorch_utils import Conv1D
            transformers.modeling_utils.Conv1D = Conv1D

        device_override = os.environ.get("EMBEDDING_DEVICE", "").lower()
        if device_override:
            device = device_override
        else:
            device = "mps" if torch.backends.mps.is_available() else "cpu"
        logger.info(f"Loading {model_name} on {device}...")
        logger.info(f"PyTorch version: {torch.__version__}, MPS available: {torch.backends.mps.is_available()}")

        use_half = os.environ.get("EMBEDDING_HALF_PRECISION", "").lower() == "true"
        if use_half:
            model = SentenceTransformer(model_name, device=device, trust_remote_code=True, model_kwargs={"torch_dtype": "float16"})
            logger.info(f"Model loaded in float16 (half precision)")
        else:
            model = SentenceTransformer(model_name, device=device, trust_remote_code=True)
            logger.info(f"Model loaded in float32 (full precision)")
        logger.info(f"Running warmup...")

        # Warm up with a test embedding
        with torch.no_grad():
            test = model.encode(["warmup"], show_progress_bar=False)
        dims = len(test[0])
        logger.info(f"Warmup complete: {dims} dimensions, device={device}")
        logger.info(f"Sidecar ready (pid={os.getpid()})")
        if rerank_model_name.lower() not in RERANK_DISABLED:
            # Load (and on first run download) the reranker off the startup path; a rerank
            # request that arrives first waits on the lock, and the client falls back if it times out.
            threading.Thread(target=_warm_reranker, daemon=True).start()
    except Exception as e:
        logger.error(f"Failed to load model: {e}", exc_info=True)
        raise


@app.get("/health")
def health():
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    sample = model.encode(["dim_check"], show_progress_bar=False)
    return {
        "status": "ok",
        "model": model_name,
        "dimensions": len(sample[0]),
        "device": str(model.device),
    }


@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if not req.texts:
        return EmbedResponse(embeddings=[], dimensions=0, model=model_name)

    _mark_embed_activity()
    logger.info(f"Embed request: {len(req.texts)} texts, batch_size={req.batch_size}")
    start = time.time()

    try:
        embeddings = _encode_with_oom_fallback(req.texts, req.batch_size)
        dims = len(embeddings[0])
        elapsed = time.time() - start
        logger.info(f"Embed complete: {len(embeddings)} embeddings in {elapsed:.2f}s")
        return EmbedResponse(
            embeddings=embeddings,
            dimensions=dims,
            model=model_name,
        )
    except Exception as e:
        logger.error(f"Embedding error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _mark_embed_activity()


class RerankRequest(BaseModel):
    query: str
    texts: list[str]


class RerankResponse(BaseModel):
    scores: list[float]
    model: str


reranker = None
reranker_lock = threading.Lock()
rerank_model_name = os.environ.get("RERANK_MODEL", "").strip() or "BAAI/bge-reranker-base"
RERANK_DISABLED = {"none", "off", "false", "0"}


def _load_reranker():
    """Load the cross-encoder on first use, so a server that never reranks never pays its memory."""
    global reranker
    with reranker_lock:
        if reranker is None:
            from sentence_transformers import CrossEncoder

            logger.info(f"Loading reranker {rerank_model_name} on {model.device}...")
            reranker = CrossEncoder(rerank_model_name, device=str(model.device), max_length=512)
            logger.info("Reranker loaded")
    return reranker


def _warm_reranker():
    try:
        _load_reranker()
    except Exception as e:
        logger.error(f"Reranker failed to load: {e}", exc_info=True)


@app.post("/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest):
    """Score each text against the query with a cross-encoder; scores are probabilities from 0 to 1."""
    if rerank_model_name.lower() in RERANK_DISABLED:
        raise HTTPException(status_code=404, detail="Reranking is disabled (RERANK_MODEL)")
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    if not req.texts:
        return RerankResponse(scores=[], model=rerank_model_name)

    _mark_embed_activity()
    start = time.time()
    try:
        import torch

        with torch.no_grad():
            scores = _load_reranker().predict(
                [(req.query, text) for text in req.texts], batch_size=16, show_progress_bar=False
            )
        logger.info(f"Reranked {len(req.texts)} texts in {time.time() - start:.2f}s")
        return RerankResponse(scores=[float(s) for s in scores], model=rerank_model_name)
    except Exception as e:
        logger.error(f"Rerank error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _mark_embed_activity()


def _encode_with_oom_fallback(texts: list[str], batch_size: int) -> list[list[float]]:
    """
    Encode texts, falling back to CPU if MPS runs out of memory.
    """
    import torch

    try:
        with torch.no_grad():
            result = model.encode(
                texts,
                batch_size=batch_size,
                show_progress_bar=False,
                normalize_embeddings=True,
            )
        return result.tolist()
    except (RuntimeError,) as e:
        if "out of memory" not in str(e).lower():
            raise

        logger.warning(f"OOM with batch_size={batch_size}, len={len(texts)}. Falling back to CPU.")
        gc.collect()

        original_device = model.device
        model.to("cpu")

        try:
            cpu_batch = min(batch_size, 4)
            with torch.no_grad():
                result = model.encode(
                    texts,
                    batch_size=cpu_batch,
                    show_progress_bar=False,
                    normalize_embeddings=True,
                )
            logger.info(f"CPU fallback encoding complete ({len(texts)} texts)")
            return result.tolist()
        finally:
            try:
                model.to(original_device)
            except Exception:
                logger.warning("Could not move model back, staying on CPU")


def handle_signal(sig, _frame):
    logger.info(f"Received signal {sig}, shutting down (pid={os.getpid()})")
    sys.exit(0)


signal.signal(signal.SIGTERM, handle_signal)


def _watch_stdin():
    """
    Watch stdin for EOF — when the parent Node.js process dies (any reason),
    the pipe breaks and stdin closes. This is our most reliable way to detect
    parent death and self-terminate instead of becoming an orphan.
    """

    def _watcher():
        logger.info("Stdin watcher thread started")
        try:
            # Blocks until stdin is closed (parent died)
            while True:
                data = sys.stdin.read(1)
                if not data:
                    # EOF — parent closed the pipe
                    break
        except Exception as e:
            logger.info(f"Stdin watcher exception: {e}")
        logger.info("Parent process died (stdin closed), shutting down")
        os._exit(0)

    t = threading.Thread(target=_watcher, daemon=True)
    t.start()


def _mark_embed_activity():
    global last_embed_at
    last_embed_at = time.monotonic()


IDLE_CHECK_INTERVAL_S = 30


def _idle_timeout_s() -> float:
    raw = os.environ.get("EMBEDDING_IDLE_TIMEOUT_S", "").strip()
    try:
        return float(raw) if raw else 600.0
    except ValueError:
        return 600.0


def _watch_idle(timeout_s: float):
    """
    Shut the server down when no /embed request has arrived for timeout_s seconds.
    /health does not count, so a client polling health cannot keep the model loaded.
    """

    def _watcher():
        while True:
            time.sleep(IDLE_CHECK_INTERVAL_S)
            idle_s = time.monotonic() - last_embed_at
            if idle_s > timeout_s:
                logger.info(f"No embed requests for {idle_s:.0f}s (limit {timeout_s:.0f}s), shutting down")
                os.kill(os.getpid(), signal.SIGTERM)
                return

    threading.Thread(target=_watcher, daemon=True).start()


_idle_limit_s = _idle_timeout_s()
if _idle_limit_s > 0:
    _watch_idle(_idle_limit_s)
else:
    logger.info("Idle shutdown disabled (EMBEDDING_IDLE_TIMEOUT_S <= 0)")

# Watch stdin only for an MCP-spawned child with a pipe (not a TTY). A detached server
# sets EMBEDDING_WATCH_PARENT=0 because no parent owns it.
if os.environ.get("EMBEDDING_WATCH_PARENT") == "0":
    logger.info("Parent watch disabled (EMBEDDING_WATCH_PARENT=0)")
elif not sys.stdin.isatty():
    _watch_stdin()
else:
    logger.info("Running in terminal mode, stdin watcher disabled")
