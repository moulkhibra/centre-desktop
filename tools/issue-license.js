#!/usr/bin/env node
"use strict";

/**
 * Centre owner-side issuance CLI (Phase 3B).
 *
 * This is an offline owner-machine tool. It is intentionally outside the
 * application runtime and must not be shipped with the app.
 *
 * It reads the Ed25519 private key and the public device-binding JSON supplied
 * by the owner, signs a license envelope, and writes it to the requested
 * output path. It never generates keys, never writes the private key, and
 * never logs private key or license payload contents.
 */

const fs = require("node:fs");
const { issueLicense } = require("./license-issuer");

const USAGE = [
  "Usage:",
  "  node tools/issue-license.js \\",
  "    --private-key <ed25519-private-key.pem> \\",
  "    --key-id <key-id> \\",
  "    --device <device-binding.json> \\",
  "    --license-id <license-id> \\",
  "    --licensee <licensee-name> \\",
  "    --out <signed-license.json> \\",
  "    [--issued-at YYYY-MM-DD] [--not-before YYYY-MM-DD]",
  "",
  "The private key stays on the owner machine. The device binding contains",
  "only hashed identifiers. The output is a signed license envelope.",
].join("\n");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error("Unexpected argument: " + token);
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    let value;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else {
      value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("Missing value for --" + name);
      }
    }
    args[name] = value;
  }
  return args;
}

function readJsonFile(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error("Could not read " + label + " file.");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(label + " file is not valid JSON.");
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  const required = ["private-key", "key-id", "device", "license-id", "licensee", "out"];
  for (const name of required) {
    if (!args[name]) throw new Error("Missing required option --" + name);
  }

  let privateKey;
  try {
    privateKey = fs.readFileSync(args["private-key"]);
  } catch (error) {
    throw new Error("Could not read private key file.");
  }

  const deviceBinding = readJsonFile(args.device, "Device binding");

  const result = issueLicense({
    privateKey: privateKey,
    keyId: args["key-id"],
    deviceBinding: deviceBinding,
    licenseId: args["license-id"],
    licensee: args.licensee,
    issuedAt: args["issued-at"],
    notBefore: args["not-before"],
  });

  if (!result.ok) {
    throw new Error(result.error + " (" + result.code + ")");
  }

  try {
    fs.writeFileSync(
      args.out,
      JSON.stringify(result.data, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (error) {
    throw new Error("Could not write signed license file.");
  }

  process.stdout.write("Signed license written to " + args.out + "\n");
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write("Error: " + error.message + "\n");
    process.exitCode = 1;
  }
}

module.exports = {
  main: main,
  parseArgs: parseArgs,
};
