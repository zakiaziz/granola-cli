// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { buildRegistry } from "./catalog.js";
import { commandLabel, optionDescription, optionLabel } from "./help.js";
import type { Provider } from "./provider.js";
import { GLOBAL_OPTIONS } from "./registry.js";

/** Renders the README "## Commands" and "## Global options" sections from the registry (STYLE-DOC-1). */
export function readmeReference(provider: Provider): string {
  return `${commandsSection(provider)}\n${globalOptionsSection()}`;
}

function commandsSection(provider: Provider): string {
  const registry = buildRegistry(provider);
  const groups = registry.rootOrder().map((word) => {
    const rows = registry.under([word]).map((spec) => {
      const options = spec.options.map(optionLabel).join(", ");
      return row([commandLabel(registry.bin, spec), spec.summary, options === "" ? "None" : options]);
    });
    return [`### ${word}`, "", "| Command | Description | Options |", "| --- | --- | --- |", ...rows, ""].join("\n");
  });
  return ["## Commands", "", ...groups].join("\n");
}

function globalOptionsSection(): string {
  const rows = GLOBAL_OPTIONS.map((option) =>
    row([`${option.short ? `-${option.short}, ` : ""}${optionLabel(option)}`, optionDescription(option)]),
  );
  return ["## Global options", "", "| Option | Description |", "| --- | --- |", ...rows, "", ACCEPTED_GLOBALS, ""].join("\n");
}

const ACCEPTED_GLOBALS =
  "Network commands (the resource commands, `auth verify`, and `api request`) accept every option except `--version`. Local commands (`setup`, `profiles`, and `config`) accept `--help`, `--format`, `--color`, `--quiet`, `--verbose`, and `--no-input`. `completions` accepts only `--help`. With no command, only `--help`, `--version`, `--verbose`, and `--quiet` apply, and `--version` with a command word fails.";

function row(cells: string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
}
