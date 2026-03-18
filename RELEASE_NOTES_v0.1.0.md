# Release v0.1.0

Initial public release of Code Graph Context MCP Server - a Model Context Protocol server that provides rich code graph context to LLMs through semantic search and intelligent graph traversal.

## 🎉 Major Features

### Weighted Graph Traversal
- **Intelligent path scoring** using relationship weights, semantic similarity, and depth penalties
- **Configurable traversal modes** for different use cases (exhaustive vs. relevant)
- **Depth-by-depth exploration** with automatic pruning of low-relevance paths
- Default weights for core TypeScript and framework-specific relationships

### NPM Package Distribution
- Published as `code-graph-context` on npm
- Simple global install: `npm install -g code-graph-context`
- Flexible Neo4j configuration via environment variables
- Works with local, Docker, cloud (Aura), or enterprise Neo4j instances

### Enhanced Documentation
- Comprehensive weighted traversal guide with scoring algorithm details
- Claude Code integration tips for `claude.md` files
- Trigger word hints and query patterns
- Framework-specific usage examples

## 🚀 Features

- **Rich Code Graph Generation**: Parse TypeScript/NestJS projects into detailed Neo4j graphs
- **Semantic Search**: OpenAI embedding-based search for finding relevant code
- **Weighted Traversal**: Smart exploration prioritizing important relationships
- **Framework-Aware**: Built-in NestJS support with extensible schema system
- **MCP Integration**: Seamless Claude Code integration

## 📦 Installation

```bash
# Install globally via npm
npm install -g code-graph-context

# Set up Neo4j (Docker)
docker run -d \
  --name code-graph-neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/PASSWORD \
  -e NEO4J_PLUGINS='["apoc"]' \
  neo4j:5.15

# Add to Claude Code
claude mcp add code-graph-context code-graph-context
```

## 🔧 Technical Improvements

- Add `relationshipWeight` property to edge schema interfaces
- Implement `RelationshipExtractor` for declarative edge definitions
- Add deferred edge resolution for EXTENDS/IMPLEMENTS relationships
- Depth-by-depth Cypher query with combined scoring
- Framework edge weights (NestJS, FairSquare)
- Increase default code snippet length to 1000 chars

## 📝 Documentation

- Weighted traversal scoring algorithm documentation
- NPM package installation guide
- Claude Code integration patterns
- Framework-specific node types and relationships
- Common query examples

## 🐛 Bug Fixes

- Fix package.json bin path format
- Normalize repository URL

## 📚 Requirements

- Node.js >= 18
- Neo4j >= 5.0 with APOC plugin
- OpenAI API Key

## 🔗 Links

- **NPM Package**: https://www.npmjs.com/package/code-graph-context
- **GitHub**: https://github.com/drew-paragon/code-graph-context
- **Documentation**: See README.md

---

**Full Changelog**: https://github.com/drew-paragon/code-graph-context/commits/v0.1.0
