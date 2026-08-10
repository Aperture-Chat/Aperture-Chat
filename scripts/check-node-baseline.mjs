import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const baseline = read(".nvmrc").trim();

if (!/^\d+$/.test(baseline)) {
  throw new Error(`.nvmrc must contain one Node.js major version; received ${JSON.stringify(baseline)}`);
}

const packageJson = JSON.parse(read("package.json"));
const expectedEngine = `>=${baseline}`;
if (packageJson.engines?.node !== expectedEngine) {
  throw new Error(
    `package.json engines.node must be ${JSON.stringify(expectedEngine)}; received ${JSON.stringify(packageJson.engines?.node)}`,
  );
}

const dockerfile = read("apps/web/Dockerfile");
if (!dockerfile.includes(`ARG NODE_VERSION=${baseline}`)) {
  throw new Error(`apps/web/Dockerfile must default NODE_VERSION to ${baseline}`);
}

const ciWorkflow = read(".github/workflows/ci.yml");
if (!ciWorkflow.includes("node-version-file: .nvmrc")) {
  throw new Error("CI must read its Node.js version from .nvmrc");
}

console.log(`Node.js baseline is aligned on ${baseline}.x.`);
