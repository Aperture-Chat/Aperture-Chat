/* Elastic Analytics export, performed end to end against a real local
 * Elasticsearch cluster and Kibana.
 *
 * Inputs: CAPTURE_ELASTIC_URL (a single-node Elasticsearch with security on,
 * reachable from the API, e.g. http://localhost:9217), CAPTURE_KIBANA_URL (its
 * Kibana), and CAPTURE_ELASTIC_ADMIN_FILE (ignored JSON with a superuser
 * "username" and "password"). Run from a freshly reset instance, whose stored
 * Elastic settings point at a cluster that is not running.
 *
 * owner-elastic records the real failing state, checks a synthetic Elastic
 * Cloud ID without saving, mints an export key with the panel's recommended
 * request, saves and checks the self-managed endpoint, syncs and waits for the
 * documents to arrive, downloads the Kibana data views, imports them in Kibana
 * for real, and opens Discover on the exported audit trail. The API key is
 * typed only after its frame; the Kibana password is never photographed.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A syntactically valid Cloud ID for a deployment that does not exist:
// "examplecorp:" + base64("us-east-1.aws.example.com$0123456789abcdef$fedcba9876543210").
const CLOUD_ID = `examplecorp:${Buffer.from("us-east-1.aws.example.com$0123456789abcdef$fedcba9876543210").toString("base64")}`;

async function scrollTo(page, locator, block = "center") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

async function elasticPanel(page) {
  const panel = page.locator(".elastic-settings-panel");
  await panel.waitFor();
  const toggle = panel.locator(".panel-collapse-button").first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await panel.locator(".elastic-card").waitFor();
  await page.waitForTimeout(600);
  return panel;
}

const REQUEST_BODY = {
  name: "aperture-export",
  role_descriptors: {
    aperture_export: {
      cluster: ["monitor"],
      indices: [{ names: ["aperture-*"], privileges: ["create_index", "index", "read"] }],
    },
  },
};

const elastic = {
  role: "owner",
  description: "Connect a real Elasticsearch cluster, sync, and import the data views into Kibana.",
  externalOrigins: () => [new URL(process.env.CAPTURE_KIBANA_URL || "http://invalid.localhost").origin],
  frames: [
    "owner/el-failing", "owner/el-cloud-id", "owner/el-key-help", "owner/el-self-managed", "owner/el-checked",
    "owner/el-streams", "owner/el-synced", "owner/kb-import", "owner/kb-imported", "owner/kb-discover",
  ],
  async run(kit) {
    const { shot } = kit;
    const esUrl = kit.env("CAPTURE_ELASTIC_URL").replace(/\/$/, "");
    const kibanaUrl = kit.env("CAPTURE_KIBANA_URL").replace(/\/$/, "");
    const admin = JSON.parse(fs.readFileSync(kit.env("CAPTURE_ELASTIC_ADMIN_FILE"), "utf8"));
    const basic = `Basic ${Buffer.from(`${admin.username}:${admin.password}`).toString("base64")}`;
    const es = async (method, pathname, body) => {
      const response = await fetch(`${esUrl}${pathname}`, {
        method, headers: { authorization: basic, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      if (!response.ok && response.status !== 404) throw new Error(`Elasticsearch ${method} ${pathname}: ${response.status} ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    };
    // Start from an empty cluster so the counts are this run's.
    for (const index of (await es("GET", "/_cat/indices/aperture-*?format=json&expand_wildcards=all")) ?? []) {
      await es("DELETE", `/${index.index}`);
    }

    // ...and a Kibana without the Aperture data views, as on a first import.
    for (const suffix of ["all", "audit", "usage", "chats", "chat-messages", "documents", "users"]) {
      await fetch(`${kibanaUrl}/api/saved_objects/index-pattern/aperture-${suffix}?force=true`, {
        method: "DELETE", headers: { authorization: basic, "kbn-xsrf": "training" },
      });
    }

    const page = await kit.app("owner", "/platform/org-settings");
    const panel = await elasticPanel(page);
    await scrollTo(page, panel, "start");
    await shot("el-failing");

    // Elastic Cloud: paste the deployment's Cloud ID; Check connection tests without saving.
    const endpoint = panel.getByLabel("Elasticsearch endpoint or Cloud ID");
    await endpoint.fill(CLOUD_ID);
    await panel.getByRole("button", { name: "Check connection" }).click();
    await panel.locator(".elastic-check-list, .elastic-notice").first().waitFor({ timeout: 90000 });
    await page.waitForFunction(() => !/Checking…/.test(document.querySelector(".elastic-actions")?.textContent || ""), null, { timeout: 90000 });
    await page.waitForTimeout(800);
    await scrollTo(page, panel.locator(".elastic-actions"), "center");
    await shot("el-cloud-id");

    // Self-managed: the endpoint, plus a key made with the panel's own request.
    await panel.locator(".elastic-key-help summary").click();
    await panel.locator(".elastic-key-help pre").waitFor();
    const shown = await panel.locator(".elastic-key-help pre").innerText();
    if (!shown.includes('"create_index", "index", "read"') && !/create_index/.test(shown)) throw new Error("Unexpected key request text.");
    await endpoint.fill(esUrl);
    await scrollTo(page, panel.locator(".elastic-key-help"), "center");
    await shot("el-key-help");
    const key = await es("POST", "/_security/api_key", REQUEST_BODY);
    await panel.locator(".elastic-key-help summary").click();
    await scrollTo(page, panel.locator(".elastic-section").first(), "start");
    await shot("el-self-managed");
    await panel.getByLabel("Elastic API key").fill(key.encoded);
    await panel.getByRole("button", { name: "Save and check" }).click();
    await panel.locator(".elastic-check-list").waitFor({ timeout: 90000 });
    await page.waitForFunction(() => !/Saving…/.test(document.querySelector(".elastic-actions")?.textContent || ""), null, { timeout: 90000 });
    await page.waitForTimeout(1000);
    const checks = await panel.locator(".elastic-check-list").innerText();
    if (/fail/i.test(checks)) throw new Error(`Connection checks failed: ${checks}`);
    await scrollTo(page, panel.locator(".elastic-actions"), "start");
    await page.evaluate(() => window.scrollBy(0, -80));
    await shot("el-checked");

    await scrollTo(page, panel.locator(".elastic-toggle-list"), "start");
    await page.evaluate(() => window.scrollBy(0, -60));
    await shot("el-streams");

    // Sync now, then wait until the documents are really in the cluster.
    await panel.getByRole("button", { name: "Sync now" }).click();
    let total = 0;
    for (let i = 0; i < 60 && total === 0; i += 1) {
      await page.waitForTimeout(2000);
      await es("POST", "/aperture-*/_refresh");
      total = (await es("GET", "/aperture-*/_count"))?.count ?? 0;
    }
    if (!total) throw new Error("No documents arrived in Elasticsearch.");
    await page.reload();
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    const fresh = await elasticPanel(page);
    await fresh.locator(".elastic-stream-table").waitFor();
    await page.waitForTimeout(800);
    await scrollTo(page, fresh.locator(".elastic-stream-table"), "start");
    await page.evaluate(() => window.scrollBy(0, -60));
    await shot("el-synced");

    // Kibana data views: download from the panel, import in Kibana.
    const [download] = await Promise.all([page.waitForEvent("download"), fresh.getByRole("button", { name: "Kibana data views" }).click()]);
    const ndjson = path.join(os.tmpdir(), `aperture-kibana-${Date.now()}.ndjson`);
    await download.saveAs(ndjson);
    const kibana = kit.use(await kit.external(`${kibanaUrl}/login`));
    await kibana.locator("input[name=username]").fill(admin.username);
    await kibana.locator("input[name=password]").fill(admin.password);
    await kibana.locator("button[type=submit]").click();
    await kibana.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60000 });
    await kibana.goto(`${kibanaUrl}/app/management/kibana/objects`);
    await kibana.getByRole("heading", { name: "Saved Objects" }).waitFor({ timeout: 60000 });
    await kibana.getByRole("button", { name: "Import" }).first().click();
    const flyout = kibana.locator(".euiFlyout");
    await flyout.waitFor();
    await flyout.locator("input[type=file]").setInputFiles(ndjson);
    await kibana.waitForTimeout(1200);
    await shot("kb-import");
    await flyout.getByRole("button", { name: "Import" }).last().click();
    await flyout.getByText(/objects? imported/i).first().waitFor({ timeout: 60000 });
    if (!(await flyout.getByText(/\b7 new\b/).count())) throw new Error("Expected seven new data views.");
    await kibana.waitForTimeout(1200);
    await shot("kb-imported");
    await flyout.getByRole("button", { name: "Done" }).click().catch(() => {});

    // Discover the exported audit trail.
    // The "Aperture: audit trail" data view (id aperture-audit), last 30 days.
    await kibana.goto(`${kibanaUrl}/app/discover#/?_a=(dataSource:(dataViewId:'aperture-audit',type:dataView))&_g=(time:(from:now-30d,to:now))`);
    await kibana.getByText(/Aperture: audit trail/).first().waitFor({ timeout: 60000 });
    await kibana.waitForTimeout(6000);
    await shot("kb-discover");
    fs.rmSync(ndjson, { force: true });
  },
};

module.exports = { "owner-elastic": elastic };
