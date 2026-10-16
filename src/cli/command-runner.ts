/**
 * Runs external commands (brew, launchctl, docker, neo4j-admin) for the CLI, behind a port tests can stub.
 */

import { execFile } from 'child_process';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: { env?: Record<string, string> }): Promise<CommandResult>;
}

export class ProcessCommandRunner implements CommandRunner {
  run(command: string, args: string[], options: { env?: Record<string, string> } = {}): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        { encoding: 'utf-8', env: { ...process.env, ...options.env }, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolve({ exitCode, stdout, stderr: error && !stderr ? error.message : stderr });
        },
      );
    });
  }
}
