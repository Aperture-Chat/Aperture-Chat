import { Info, ScanSearch, ShieldCheck } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { getPrivacyDetectors, getPrivacyPolicy, previewPrivacy, updatePrivacyPolicy } from "../lib/api/dataProtection";
import type {
  PrivacyCategory,
  PrivacyDetectorCatalog,
  PrivacyPreviewResponse,
  TenantPrivacyPolicy,
  TenantPrivacyPolicyUpdateRequest,
} from "../lib/types";
import { renderConcealed } from "./ConcealedText";
import { CheckLine, Panel, Pill, Toggle } from "./Primitives";

// Synthetic values only: these are the documented test numbers for each format.
const SAMPLE_TEXT =
  "Client intake: SSN 123-45-6789, DOB 04/12/1986. Card 4111 1111 1111 1111 on file. " +
  "Reach them at jordan@example.com or (415) 555-0134. MRN: 00482913.";

const COVERAGE = [
  "Chat messages, titles, and regenerated answers, before they are saved and every time they are shown",
  "Model replies, including streamed text, before they reach the browser",
  "User Prompt Activity, feedback notes, security alert snippets, and retention tags",
  "Memories, issue reports, search results, Elastic export, and training datasets",
];

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Policies tab: organization-wide personal-data concealment. */
export function PersonalDataProtectionPanel({ actorUserId }: { actorUserId: string }) {
  const [policy, setPolicy] = useState<TenantPrivacyPolicy | null>(null);
  const [catalog, setCatalog] = useState<PrivacyDetectorCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sample, setSample] = useState(SAMPLE_TEXT);
  const [preview, setPreview] = useState<PrivacyPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const sampleId = useId();

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPrivacyPolicy(actorUserId), getPrivacyDetectors(actorUserId)])
      .then(([loadedPolicy, loadedCatalog]) => {
        if (cancelled) return;
        setPolicy(loadedPolicy);
        setCatalog(loadedCatalog);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError, "Personal data protection settings could not be loaded."));
      });
    return () => {
      cancelled = true;
    };
  }, [actorUserId]);

  const detectorsByCategory = useMemo(() => {
    const grouped = new Map<PrivacyCategory, string[]>();
    for (const detector of catalog?.detectors ?? []) {
      grouped.set(detector.category, [...(grouped.get(detector.category) ?? []), detector.label]);
    }
    return grouped;
  }, [catalog]);

  async function save(patch: TenantPrivacyPolicyUpdateRequest) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      setPolicy(await updatePrivacyPolicy(actorUserId, patch));
      setPreview(null);
    } catch (saveError) {
      setError(errorMessage(saveError, "The setting was not saved."));
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    if (previewing || !sample.trim()) return;
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await previewPrivacy(actorUserId, sample, policy?.categories));
    } catch (previewError) {
      setError(errorMessage(previewError, "The preview could not run."));
    } finally {
      setPreviewing(false);
    }
  }

  const enabled = Boolean(policy?.enabled);
  const categories = new Set(policy?.categories ?? []);
  const disabled = saving || policy === null;

  return (
    <Panel
      className="privacy-panel"
      title={
        <>
          <ShieldCheck size={18} /> Personal Data Protection
        </>
      }
      subtitle="Conceal Social Security numbers, account numbers, health identifiers, and other personal data before chats, records, and exports are saved or shown."
      actions={policy ? <Pill tone={enabled ? "success" : "neutral"}>{enabled ? "On" : "Off"}</Pill> : undefined}
      defaultCollapsed
    >
      <div className="privacy-toggle-stack">
        <div className="permission-row policy-toggle-row">
          <span>
            <strong>Conceal personal data</strong>
            <small>
              {enabled
                ? "Detected values are replaced with labeled placeholders, such as SSN or Card number, everywhere they would be stored or shown."
                : "Chats are stored and shown exactly as typed. Content filters attached to individual models still apply."}
            </small>
          </span>
          <Toggle
            checked={enabled}
            disabled={disabled}
            label="Conceal personal data"
            tooltip="Turn personal data concealment on or off for everyone in this organization"
            onChange={(next) => void save({ enabled: next })}
          />
        </div>
        <div className="permission-row policy-toggle-row">
          <span>
            <strong>Hide values from the model too</strong>
            <small>
              {policy?.conceal_from_model
                ? "Typed prompts and attached file text are concealed before they reach the model provider, so the model only sees the placeholder."
                : "The model reads the original value for that turn. It is still concealed everywhere it is stored or shown."}
            </small>
          </span>
          <Toggle
            checked={Boolean(policy?.conceal_from_model)}
            disabled={disabled || !enabled}
            label="Hide values from the model too"
            tooltip="Conceal personal data in the prompt and attachments before the provider receives them"
            onChange={(next) => void save({ conceal_from_model: next })}
          />
        </div>
      </div>

      <section className="privacy-section" aria-label="What to conceal">
        <h3 className="privacy-section-title">What to conceal</h3>
        <div className="privacy-category-grid">
          {(catalog?.categories ?? []).map((category) => {
            const checked = categories.has(category.id);
            const lastOne = checked && categories.size === 1;
            return (
              <div className={checked ? "privacy-category is-on" : "privacy-category"} key={category.id}>
                <div className="privacy-category-head">
                  <strong>{category.label}</strong>
                  <Toggle
                    checked={checked}
                    disabled={disabled || lastOne}
                    label={`Conceal ${category.label.toLowerCase()}`}
                    tooltip={
                      lastOne
                        ? "At least one kind of personal data stays selected"
                        : `Conceal ${category.label.toLowerCase()}`
                    }
                    onChange={(next) => {
                      const nextCategories = (catalog?.categories ?? [])
                        .map((item) => item.id)
                        .filter((id) => (id === category.id ? next : categories.has(id)));
                      void save({ categories: nextCategories });
                    }}
                  />
                </div>
                <p>{(detectorsByCategory.get(category.id) ?? []).join(" · ")}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="privacy-section" aria-label="Try it with sample text">
        <h3 className="privacy-section-title">Try it with sample text</h3>
        <div className="privacy-preview">
          <label htmlFor={sampleId} className="privacy-preview-label">
            Sample text. The preview is not saved or logged, so realistic test values are fine.
          </label>
          <textarea
            id={sampleId}
            rows={3}
            value={sample}
            spellCheck={false}
            onChange={(event) => {
              setSample(event.target.value);
              setPreview(null);
            }}
          />
          <div className="privacy-preview-actions">
            <button
              className="secondary-button compact"
              type="button"
              disabled={previewing || !sample.trim() || policy === null}
              data-tooltip="Show how this text is stored and displayed under the categories selected above"
              onClick={() => void runPreview()}
            >
              <ScanSearch size={14} /> {previewing ? "Checking…" : "Preview concealment"}
            </button>
            {preview && (
              <span className="privacy-preview-count" role="status">
                {preview.detections.length === 0
                  ? "Nothing detected"
                  : `${preview.detections.reduce((sum, item) => sum + item.count, 0)} value${
                      preview.detections.reduce((sum, item) => sum + item.count, 0) === 1 ? "" : "s"
                    } concealed`}
              </span>
            )}
          </div>
          {preview && (
            <div className="privacy-preview-output" aria-label="Concealed sample">
              <p>{renderConcealed(preview.concealed_sample, "preview")}</p>
              {preview.detections.length > 0 && (
                <div className="privacy-preview-pills">
                  {preview.detections.map((item) => (
                    <Pill tone="info" key={item.id}>
                      {item.label} × {item.count}
                    </Pill>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="privacy-section" aria-label="Where it applies">
        <h3 className="privacy-section-title">Where it applies</h3>
        <div className="privacy-coverage">
          {COVERAGE.map((item) => (
            <CheckLine key={item}>{item}</CheckLine>
          ))}
        </div>
        <div className="policy-callout privacy-limits">
          <Info size={15} />
          <span>
            Detection is pattern and checksum based, and it runs inside this deployment. It does not recognize names or
            free-text descriptions of someone's health. Drafts are documents of record and are not altered, and uploaded files are stored as uploaded. Chats saved
            before protection was on are concealed whenever they are shown or exported, and stored concealed the next
            time they are saved.
          </span>
        </div>
      </section>
      {error && (
        <div className="inline-warning privacy-error" role="alert">
          <span>{error}</span>
        </div>
      )}
    </Panel>
  );
}
