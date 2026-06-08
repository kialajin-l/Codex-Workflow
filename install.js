import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const home = os.homedir();
const sourceDir = process.cwd();
const codexHomeDir = path.join(home, ".codex");
const codexSkillDir = path.join(codexHomeDir, "skills", "codex-workflow");
const deepworkSkillDir = path.join(codexHomeDir, "skills", "deepwork");
const userConfigDir = path.join(codexHomeDir, "codex-workflow");
const runtimeDir = path.join(userConfigDir, "runtime");
const binDir = path.join(userConfigDir, "bin");
const agentsDir = path.join(codexSkillDir, "agents");
const localPluginsRoot = path.join(home, "plugins");
const localPluginDir = path.join(localPluginsRoot, "codex-workflow");
const marketplaceDir = path.join(home, ".agents", "plugins");
const marketplacePath = path.join(marketplaceDir, "marketplace.json");
const builtinWorkflowNames = new Set(["pdca-default.json", "lint-gate.json"]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function requirePath(relativePath) {
  const resolved = path.join(sourceDir, relativePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing required install asset: ${relativePath}`);
  }
  return resolved;
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyDirForce(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirForce(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function syncBuiltinWorkflows(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (builtinWorkflowNames.has(entry.name) || !fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyFile(relativePath, destDir) {
  const srcPath = requirePath(relativePath);
  ensureDir(destDir);
  fs.copyFileSync(srcPath, path.join(destDir, path.basename(relativePath)));
}

function installRuntimeBundle() {
  const distSrc = requirePath("dist");
  const zodSrc = requirePath(path.join("node_modules", "zod"));

  ensureDir(runtimeDir);
  copyDirForce(distSrc, path.join(runtimeDir, "dist"));
  copyDirForce(zodSrc, path.join(runtimeDir, "node_modules", "zod"));
  copyFile("package.json", runtimeDir);
  copyFile("workflow.config.json", runtimeDir);
  copyFile("model-profiles.json", runtimeDir);
}

function readPluginVersion() {
  const manifestPath = requirePath(path.join(".codex-plugin", "plugin.json"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("Missing plugin version in .codex-plugin/plugin.json");
  }
  return manifest.version;
}

function hasInstalledCommandCache(marketplaceName, pluginVersion) {
  const commandPath = path.join(
    codexHomeDir,
    "plugins",
    "cache",
    marketplaceName,
    "codex-workflow",
    pluginVersion,
    "commands",
    "deepwork.md",
  );
  return fs.existsSync(commandPath);
}

function hasEnabledPluginConfig(selector) {
  const configPath = path.join(codexHomeDir, "config.toml");
  if (!fs.existsSync(configPath)) {
    return false;
  }

  const sectionHeader = `[plugins."${selector}"]`;
  let inSection = false;
  for (const line of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = trimmed === sectionHeader;
      continue;
    }

    if (inSection && /^enabled\s*=\s*true\b/.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function copyPluginAsset(relativePath) {
  const srcPath = requirePath(relativePath);
  const destPath = path.join(localPluginDir, relativePath);
  ensureDir(path.dirname(destPath));
  fs.copyFileSync(srcPath, destPath);
}

function installPluginBundle() {
  ensureDir(localPluginDir);
  copyDirForce(path.join(sourceDir, ".codex-plugin"), path.join(localPluginDir, ".codex-plugin"));
  copyDirForce(path.join(sourceDir, "assets"), path.join(localPluginDir, "assets"));
  copyDirForce(path.join(sourceDir, "commands"), path.join(localPluginDir, "commands"));
  copyDirForce(path.join(sourceDir, "skills"), path.join(localPluginDir, "skills"));
  copyPluginAsset(".mcp.json");
  copyPluginAsset("README.md");
  copyPluginAsset("README.en.md");
  copyPluginAsset("SKILL.md");
  copyPluginAsset("LICENSE");
}

function readMarketplace() {
  if (!fs.existsSync(marketplacePath)) {
    return {
      name: "personal",
      interface: {
        displayName: "Personal",
      },
      plugins: [],
    };
  }

  return JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
}

function ensureMarketplaceEntry() {
  ensureDir(marketplaceDir);
  const marketplace = readMarketplace();
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];

  const entry = {
    name: "codex-workflow",
    source: {
      source: "local",
      path: "./plugins/codex-workflow",
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };

  const existingIndex = marketplace.plugins.findIndex((plugin) => plugin?.name === "codex-workflow");
  if (existingIndex >= 0) {
    marketplace.plugins[existingIndex] = entry;
  } else {
    marketplace.plugins.push(entry);
  }

  fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2), "utf8");
  return marketplace.name;
}

function installCodexPlugin(marketplaceName) {
  const pluginVersion = readPluginVersion();
  const selector = `codex-workflow@${marketplaceName}`;
  if (hasInstalledCommandCache(marketplaceName, pluginVersion) && hasEnabledPluginConfig(selector)) {
    console.log(`Codex plugin cache and config already contain /deepwork for version ${pluginVersion}; skipping reinstall.`);
    return;
  }

  const result = spawnSync("codex", ["plugin", "add", selector], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.warn(`Could not refresh the Codex App plugin cache automatically: ${result.error.message}`);
    console.warn("Runtime, wrappers, skills, and the local marketplace entry were still installed.");
    console.warn(`After closing Codex App, retry manually: codex plugin add ${selector}`);
    return;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    if (hasInstalledCommandCache(marketplaceName, pluginVersion) && hasEnabledPluginConfig(selector)) {
      console.warn(`codex plugin add exited with code ${result.status}, but the desired plugin cache already exists.`);
      return;
    }

    if (result.stdout) {
      console.warn(result.stdout.trim());
    }
    if (result.stderr) {
      console.warn(result.stderr.trim());
    }
    console.warn(`codex plugin add exited with code ${result.status}; runtime installation still completed.`);
    console.warn("If this was a Windows access-denied error, close Codex App and retry so its plugin cache is not locked.");
    console.warn(`Manual retry command: codex plugin add ${selector}`);
    return;
  }

  if (result.stdout) {
    console.log(result.stdout.trim());
  }
}

function writeWindowsCmdWrapper() {
  const filePath = path.join(binDir, "cwf.cmd");
  const content = [
    "@echo off",
    "setlocal",
    "set CODEX_WORKFLOW_CALLER_CWD=%CD%",
    "set SCRIPT_DIR=%~dp0",
    "set RUNTIME_DIR=%SCRIPT_DIR%..\\runtime",
    "node \"%RUNTIME_DIR%\\dist\\index.js\" %*",
    "set EXIT_CODE=%ERRORLEVEL%",
    "exit /b %EXIT_CODE%",
    "",
  ].join("\r\n");
  fs.writeFileSync(filePath, content, "utf8");
}

function writePowerShellWrapper() {
  const filePath = path.join(binDir, "cwf.ps1");
  const content = [
    "$ErrorActionPreference = 'Stop'",
    "$env:CODEX_WORKFLOW_CALLER_CWD = (Get-Location).Path",
    "$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "$runtimeDir = Join-Path $scriptDir '..\\runtime'",
    "$entry = Join-Path $runtimeDir 'dist/index.js'",
    "& node $entry @args",
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");
  fs.writeFileSync(filePath, content, "utf8");
}

function writeUnixWrapper() {
  const filePath = path.join(binDir, "cwf");
  const content = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "export CODEX_WORKFLOW_CALLER_CWD=\"${PWD}\"",
    "SCRIPT_DIR=\"$(cd -- \"$(dirname -- \"${BASH_SOURCE[0]}\")\" && pwd)\"",
    "RUNTIME_DIR=\"${SCRIPT_DIR}/../runtime\"",
    "exec node \"${RUNTIME_DIR}/dist/index.js\" \"$@\"",
    "",
  ].join("\n");
  fs.writeFileSync(filePath, content, "utf8");
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Ignore chmod failures on platforms that do not support it.
  }
}

function installWrappers() {
  ensureDir(binDir);
  writeWindowsCmdWrapper();
  writePowerShellWrapper();
  writeUnixWrapper();
}

requirePath("SKILL.md");
requirePath(path.join("skills", "deepwork", "SKILL.md"));
requirePath(".codex-plugin");
requirePath("commands");
requirePath("agents");
requirePath("hooks");
requirePath("skills");
requirePath("workflows");
requirePath("workflow.config.json");
requirePath("model-profiles.json");
requirePath("package.json");
requirePath("dist");
requirePath(path.join("node_modules", "zod"));

ensureDir(codexSkillDir);
fs.copyFileSync(path.join(sourceDir, "SKILL.md"), path.join(codexSkillDir, "SKILL.md"));
ensureDir(deepworkSkillDir);
fs.copyFileSync(path.join(sourceDir, "skills", "deepwork", "SKILL.md"), path.join(deepworkSkillDir, "SKILL.md"));
ensureDir(agentsDir);
copyDirForce(path.join(sourceDir, "agents"), agentsDir);

ensureDir(userConfigDir);
copyDir(path.join(sourceDir, "hooks"), path.join(userConfigDir, "hooks"));
copyDir(path.join(sourceDir, "skills"), path.join(userConfigDir, "skills"));
ensureDir(path.join(userConfigDir, "workflows"));
syncBuiltinWorkflows(path.join(sourceDir, "workflows"), path.join(userConfigDir, "workflows"));
installRuntimeBundle();
installWrappers();
installPluginBundle();
const marketplaceName = ensureMarketplaceEntry();
installCodexPlugin(marketplaceName);

const pdcaDefaultPath = path.join(userConfigDir, "workflows", "pdca-default.json");
if (!fs.existsSync(pdcaDefaultPath)) {
  fs.writeFileSync(pdcaDefaultPath, JSON.stringify({
    name: "pdca-default",
    hooks: {
      "task.before_dispatch.json": {
        event: "task:before_dispatch",
        default_exec_mode: "cli",
        rules: [],
      },
      "task.after_result.json": {
        event: "task:after_result",
        rules: [],
      },
      "review.after.json": {
        event: "review:after",
        rules: [],
      },
    },
  }, null, 2));
}

console.log(`Installed Codex Workflow assets into ${codexHomeDir}`);
console.log(`DeepWork skill alias: ${deepworkSkillDir}`);
console.log(`Runtime directory: ${runtimeDir}`);
console.log(`Wrapper scripts: ${binDir}`);
console.log(`Plugin source directory: ${localPluginDir}`);
console.log(`Marketplace entry: codex-workflow@${marketplaceName}`);
