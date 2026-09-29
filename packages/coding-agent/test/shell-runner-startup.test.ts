import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { installFakeDocker } from "./fake-docker-cli.ts";

// issue #17: the active shell runner is shown at startup, on stderr in non-interactive modes.

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverPath = resolve(__dirname, "../src/experimental/source-resolver.ts");
const roots: string[] = [];
const describeUnix = process.platform === "win32" ? describe.skip : describe;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface CliRun {
	stdout: string;
	stderr: string;
	projectDir: string;
	sessionCwd: string;
}

async function runCli(options: { globalSettings?: string; args: string[]; withSession?: boolean }): Promise<CliRun> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "shell-runner-startup-")));
	roots.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const sessionCwd = join(root, "session-cwd");
	mkdirSync(agentDir);
	mkdirSync(projectDir);
	mkdirSync(sessionCwd);
	if (options.globalSettings !== undefined) writeFileSync(join(agentDir, "settings.json"), options.globalSettings);
	const docker = installFakeDocker(root);
	const args = [...options.args];
	if (options.withSession) {
		const sessionFile = join(root, "session.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "startup-test", timestamp: new Date().toISOString(), cwd: sessionCwd })}\n`,
		);
		args.push("--session", sessionFile);
	}

	let stdout = "";
	let stderr = "";
	await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverPath, cliPath, "--no-extensions", ...args], {
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				PATH: `${docker.binDir}:${process.env.PATH}`,
				FAKE_DOCKER_STATE: docker.stateDir,
				DOCKER_HOST: "",
				DOCKER_CONTEXT: "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});
	return { stdout, stderr, projectDir, sessionCwd };
}

const dockerSettings = JSON.stringify({ shellRunner: { type: "docker", image: "shell:test" } });

// Each test starts the CLI from source, which is slow when the whole suite runs in parallel.
describeUnix("shell runner startup notice", { timeout: 120_000 }, () => {
	it.each([
		["print", ["-p", "hello"]],
		["json", ["--mode", "json", "hello"]],
		["rpc", ["--mode", "rpc"]],
	])("shows the Docker runner and its mounts on stderr in %s mode", async (_mode, args) => {
		const run = await runCli({ globalSettings: dockerSettings, args });
		expect(run.stderr).toContain(
			`Shell runner: docker (image shell:test). Mounts: ${run.projectDir} (read-write). Environment allowlist: none. Only the built-in bash tool and ! commands run in the container`,
		);
		expect(run.stdout).not.toContain("Shell runner:");
	});

	it("resolves the default mount against the session cwd chosen with --session", async () => {
		const run = await runCli({ globalSettings: dockerSettings, args: ["-p", "hello"], withSession: true });
		expect(run.stderr).toContain(`Mounts: ${run.sessionCwd} (read-write).`);
	});

	it("shows an explicit host runner", async () => {
		const host = await runCli({
			globalSettings: JSON.stringify({ shellRunner: { type: "host" } }),
			args: ["-p", "hi"],
		});
		expect(host.stderr).toContain("Shell runner: host. Commands run directly on this machine.");
		expect(host.stdout).not.toContain("Shell runner:");
	});

	it("prints nothing without the setting", async () => {
		const absent = await runCli({ args: ["-p", "hi"] });
		expect(absent.stderr).not.toContain("Shell runner:");
		expect(absent.stdout).not.toContain("Shell runner:");
	});

	it("warns that an invalid selection blocks commands until fixed and restarted", async () => {
		const run = await runCli({ globalSettings: "", args: ["-p", "hi"] });
		expect(run.stderr).toMatch(
			/Warning: Shell runner: blocked\. Global settings file .*settings\.json cannot be used: the file is empty\. Shell commands will not run, on the host or elsewhere; fix this and restart\./,
		);
		expect(run.stdout).not.toContain("Shell runner:");
	});
});
