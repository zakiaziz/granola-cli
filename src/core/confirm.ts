// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CliError } from "./errors.js";
import { exitInterrupted, noteProfileShown } from "./output.js";
import type { GlobalOptions } from "./types.js";
import { echoable } from "./values.js";

const CONFIRMATION_PROMPT = "Continue? [y/N] ";
const MAX_CHANGE_VALUE_LENGTH = 80;

/** A field value the operation will change, already redacted. */
export interface ShownChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ConfirmationRequest {
  providerName: string;
  /** The profile that supplies the credential and endpoint. */
  profile: string;
  operation: string;
  requests: { method: string; url: string }[];
  changes: ShownChange[];
  effect: string;
}

export function isCiMode(): boolean {
  const value = process.env.CI;
  if (value === undefined || value === "") return false;
  const normalized = value.toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

export function canPrompt(globals: GlobalOptions, stdinCarriesContent: boolean): boolean {
  if (globals.noInput || isCiMode() || stdinCarriesContent) return false;
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

export async function confirmMutation(
  request: ConfirmationRequest,
  options: { yes: boolean; globals: GlobalOptions; stdinCarriesContent: boolean },
): Promise<void> {
  if (options.yes) return;
  if (!canPrompt(options.globals, options.stdinCarriesContent)) {
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      `"${request.operation}" changes ${request.providerName} state and needs confirmation.`,
      { hint: "Re-run with --yes to confirm or --dry-run to preview." },
    );
  }
  noteProfileShown();
  const answer = await ask(confirmationSummary(request), CONFIRMATION_PROMPT);
  if (/^y(es)?$/i.test(answer.trim())) return;
  throw new CliError("CONFIRMATION_DECLINED", "Cancelled. Nothing was sent.");
}

/** Prompts for a value that is not secret, such as an email. Input is echoed. */
export async function promptVisible(providerName: string, label: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  readline.on("SIGINT", exitInterrupted);
  try {
    return await readAnswer(readline, `${providerName} ${label}: `);
  } finally {
    readline.close();
  }
}

export async function promptHidden(providerName: string, label: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stderr.write(chunk, encoding);
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  readline.on("SIGINT", () => {
    process.stderr.write("\n");
    exitInterrupted();
  });
  try {
    process.stderr.write(`Enter the ${providerName} ${label}. Input is hidden.\n`);
    process.stderr.write(`${providerName} ${label}: `);
    muted = true;
    const answer = await readAnswer(readline, "");
    process.stderr.write("\n");
    return answer;
  } catch (error) {
    process.stderr.write("\n");
    throw error;
  } finally {
    readline.close();
  }
}

async function ask(summary: string, prompt: string): Promise<string> {
  process.stderr.write(summary);
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  readline.on("SIGINT", exitInterrupted);
  try {
    return await readAnswer(readline, prompt);
  } finally {
    readline.close();
  }
}

function readAnswer(readline: Interface, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    readline.once("close", () => reject(new CliError("INTERRUPTED", "Interrupted.")));
    readline.question(prompt).then(resolve, reject);
  });
}

function confirmationSummary(request: ConfirmationRequest): string {
  const requests = request.requests.map((item) => `  Request:    ${item.method} ${item.url}\n`).join("");
  const changes = request.changes
    .map((item) => `  Change:     ${echoable(item.field)}: ${shownValue(item.before)} -> ${shownValue(item.after)}\n`)
    .join("");
  return [
    `Confirm ${request.providerName} mutation\n`,
    `  Profile:    ${request.profile}\n`,
    `  Operation:  ${request.operation}\n`,
    requests,
    changes,
    `  Effect:     ${request.effect}\n`,
  ].join("");
}

function shownValue(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length > MAX_CHANGE_VALUE_LENGTH ? `${text.slice(0, MAX_CHANGE_VALUE_LENGTH - 3)}...` : text;
}
