import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { build as viteBuild } from "vite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => root,
  getNewLine: () => ts.sys.newLine,
};

function reportDiagnostic(diagnostic) {
  const output = ts.formatDiagnostic(diagnostic, formatHost);
  if (diagnostic.category === ts.DiagnosticCategory.Error) {
    console.error(output);
    return;
  }
  console.info(output);
}

function reportErrorSummary(errorCount) {
  if (errorCount > 0) {
    console.error(`${errorCount} TypeScript error${errorCount === 1 ? "" : "s"} found.`);
  }
}

function runTypecheck() {
  const host = ts.createSolutionBuilderHost(
    ts.sys,
    undefined,
    reportDiagnostic,
    reportDiagnostic,
    reportErrorSummary,
  );
  const builder = ts.createSolutionBuilder(host, [resolve(root, "tsconfig.json")], {
    pretty: true,
  });
  const status = builder.build();

  if (status !== ts.ExitStatus.Success) {
    throw new Error("Typecheck failed.");
  }
}

function assertVersionsAligned() {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(root, "komari-theme.json"), "utf8"));
  if (pkg.version !== manifest.version) {
    throw new Error(
      `Version mismatch: package.json is ${pkg.version} but komari-theme.json is ${manifest.version}. ` +
        "Align them before releasing — the packaged zip is named from komari-theme.json.",
    );
  }
}

async function importScript(path) {
  const url = pathToFileURL(resolve(root, path));
  url.search = `?t=${Date.now()}`;
  await import(url.href);
}

console.log("Checking versions...");
assertVersionsAligned();

console.log("Type checking...");
runTypecheck();

console.log("Building...");
await viteBuild({ root });

console.log("Packaging...");
await importScript("scripts/make-preview.mjs");
await importScript("scripts/package-zip.mjs");
