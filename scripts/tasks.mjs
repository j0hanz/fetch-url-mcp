/* eslint-disable */
import { spawn } from 'node:child_process';
import { access, chmod, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

// --- Configuration (Single Source of Truth) ---
const CONFIG = {
  paths: {
    dist: 'dist',
    assets: 'assets',
    instructions: 'src/instructions.md',
    executable: 'dist/index.js',
    tsBuildInfo: [
      '.tsbuildinfo',
      'tsconfig.tsbuildinfo',
      'tsconfig.build.tsbuildinfo',
    ],
    get distAssets() {
      return join(this.dist, 'assets');
    },
    get distInstructions() {
      return join(this.dist, 'instructions.md');
    },
  },
  commands: {
    tsc: ['npx', ['tsc', '-p', 'tsconfig.build.json']],
    tscCheck: ['npx', ['tsc', '-p', 'tsconfig.json', '--noEmit']],
  },
};

// --- Infrastructure Layer (IO & System) ---
const Logger = {
  startGroup: (name) => process.stdout.write(`> ${name}... `),
  endGroupSuccess: (duration) => console.log(`✅ (${duration}s)`),
  endGroupFail: () => console.log(`❌`),
  shellSuccess: (name, duration) => console.log(`> ${name} ✅ (${duration}s)`),
  shellFail: (name, error) => console.log(`> ${name} ❌ (${error.message})`),
  info: (msg) => console.log(msg),
  error: (err) => console.error(err),
  newLine: () => console.log(),
};

const System = {
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },

  async remove(paths) {
    const targets = Array.isArray(paths) ? paths : [paths];
    await Promise.all(
      targets.map((p) => rm(p, { recursive: true, force: true }))
    );
  },

  async copy(src, dest, opts = {}) {
    await cp(src, dest, opts);
  },

  async makeDir(path) {
    await mkdir(path, { recursive: true });
  },

  async changeMode(path, mode) {
    await chmod(path, mode);
  },

  exec(command, args = []) {
    return new Promise((resolve, reject) => {
      const useShell = command !== 'node';
      const spawnArgs = useShell ? [] : args;
      const spawnCommand = useShell
        ? [command, ...args]
            .map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))
            .join(' ')
        : command;

      const proc = spawn(spawnCommand, spawnArgs, {
        stdio: 'inherit',
        shell: useShell,
      });

      proc.on('close', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`${command} exited with code ${code}`));
      });
    });
  },
};

// --- Domain Layer (Build & Test Actions) ---
const BuildTasks = {
  async clean() {
    await System.remove(CONFIG.paths.dist);
    await System.remove(CONFIG.paths.tsBuildInfo);
  },

  async compile() {
    const [cmd, args] = CONFIG.commands.tsc;
    await System.exec(cmd, args);
  },

  async validate() {
    if (!(await System.exists(CONFIG.paths.instructions))) {
      throw new Error(`Missing ${CONFIG.paths.instructions}`);
    }
  },

  async assets() {
    await System.makeDir(CONFIG.paths.dist);
    await System.copy(CONFIG.paths.instructions, CONFIG.paths.distInstructions);

    if (await System.exists(CONFIG.paths.assets)) {
      await System.copy(CONFIG.paths.assets, CONFIG.paths.distAssets, {
        recursive: true,
      });
    }
  },

  async makeExecutable() {
    await System.changeMode(CONFIG.paths.executable, '755');
  },
};

const TestTasks = {
  async typeCheck() {
    await Runner.runShellTask('Type-checking src', async () => {
      const [cmd, args] = CONFIG.commands.tscCheck;
      await System.exec(cmd, args);
    });
  },

  async test(args = []) {
    await Pipeline.fullBuild();

    const extraArgs = args.includes('--coverage')
      ? ['--experimental-test-coverage']
      : [];

    await Runner.runShellTask('Running tests', async () => {
      await System.exec('node', [
        '--test',
        '--experimental-transform-types',
        ...extraArgs,
      ]);
    });
  },
};

// --- Application Layer (Task Running & Orchestration) ---
class Runner {
  static async runTask(name, fn) {
    Logger.startGroup(name);
    const start = performance.now();

    try {
      await fn();
      Logger.endGroupSuccess(((performance.now() - start) / 1000).toFixed(2));
    } catch (err) {
      Logger.endGroupFail();
      throw err;
    }
  }

  static async runShellTask(name, fn) {
    Logger.startGroup(name);
    Logger.newLine();
    const start = performance.now();

    try {
      await fn();
      Logger.shellSuccess(
        name,
        ((performance.now() - start) / 1000).toFixed(2)
      );
    } catch (err) {
      Logger.shellFail(name, err);
      throw err;
    }
  }
}

const Pipeline = {
  async fullBuild() {
    Logger.info('🚀 Starting build...');
    const start = performance.now();

    await Runner.runTask('Cleaning dist', BuildTasks.clean);
    await Runner.runShellTask('Compiling TypeScript', BuildTasks.compile);
    await Runner.runTask('Validating instructions', BuildTasks.validate);
    await Runner.runTask('Copying assets', BuildTasks.assets);
    await Runner.runTask('Making executable', BuildTasks.makeExecutable);

    Logger.info(
      `\n✨ Build completed in ${((performance.now() - start) / 1000).toFixed(
        2
      )}s`
    );
  },
};

// --- Interface Layer (CLI) ---
const CLI = {
  routes: {
    clean: () => Runner.runTask('Cleaning', BuildTasks.clean),
    'copy:assets': () => Runner.runTask('Copying assets', BuildTasks.assets),
    'validate:instructions': () =>
      Runner.runTask('Validating instructions', BuildTasks.validate),
    'make-executable': () =>
      Runner.runTask('Making executable', BuildTasks.makeExecutable),
    build: Pipeline.fullBuild,
    'type-check': () => TestTasks.typeCheck(),
    test: (args) => TestTasks.test(args),
  },

  async main(args) {
    const taskName = args[2] ?? 'build';
    const restArgs = args.slice(3);
    const action = this.routes[taskName];

    if (!action) {
      Logger.error(`Unknown task: ${taskName}`);
      Logger.error(`Available tasks: ${Object.keys(this.routes).join(', ')}`);
      process.exit(1);
    }

    try {
      await action(restArgs);
    } catch {
      process.exit(1);
    }
  },
};

CLI.main(process.argv);
