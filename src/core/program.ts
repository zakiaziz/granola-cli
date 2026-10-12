// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { readFileSync } from "node:fs";
import { parseArgv, prescanPresentation, type Invocation } from "./args.js";
import { buildRegistry } from "./catalog.js";
import { asCliError } from "./errors.js";
import { helpFor, version } from "./help.js";
import { configureOutput, exitInterrupted, printError, printText } from "./output.js";
import type { Provider } from "./provider.js";
import type { Registry } from "./registry.js";
import type { PackageInfo } from "./types.js";

/**
 * Program entry. packageUrl is the tool's package.json, resolved by the entry
 * module as new URL("../package.json", import.meta.url) (STYLE-VER-1).
 */
export function runCli(provider: Provider, packageUrl: URL): void {
  const argv = process.argv.slice(2);
  configureOutput({ bin: provider.bin, ...prescanPresentation(argv), verbose: false, quiet: false });
  process.once("SIGINT", exitInterrupted);
  main(provider, packageUrl, argv).catch((error: unknown) => {
    const failure = asCliError(error);
    printError(failure);
    process.exitCode = failure.exitCode;
  });
}

async function main(provider: Provider, packageUrl: URL, argv: readonly string[]): Promise<void> {
  const info = JSON.parse(readFileSync(packageUrl, "utf8")) as PackageInfo;
  const registry = buildRegistry(provider);
  const invocation = parse(registry, argv);
  if (invocation.kind === "help") {
    printText(helpFor(registry, info, invocation.path));
    return;
  }
  if (invocation.kind === "version") {
    printText(version(provider.bin, info));
    return;
  }
  const { context } = invocation;
  const { format, color, verbose, quiet } = context.globals;
  configureOutput({ bin: provider.bin, format, color, verbose, quiet });
  await context.spec.run(context);
}

function parse(registry: Registry, argv: readonly string[]): Invocation {
  try {
    return parseArgv(registry, argv);
  } catch (error) {
    configureOutput({ bin: registry.bin, ...prescanPresentation(argv), verbose: false, quiet: false });
    throw error;
  }
}
