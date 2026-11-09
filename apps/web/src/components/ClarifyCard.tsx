import { ArrowLeft, ArrowRight, Check, MessageCircleQuestion, Sparkles } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  draftAnswers,
  isPicked,
  otherIsOn,
  pickOption,
  pickOther,
  typeOther,
  type ClarifyDraft,
  type ClarifyQuestion,
  type ClarifyResponse,
  type WaitingClarification,
} from "../lib/clarify";

/** Whether the questions can be answered here: `open` on the newest reply
 * while nothing runs, `busy` while another reply runs, `passed` once the
 * conversation moved on without an answer. */
export type ClarifyCardState = "open" | "busy" | "passed";

function questionsPhrase(count: number): string {
  return count === 1 ? "a question" : `${count} questions`;
}

function OptionRow({
  type,
  name,
  checked,
  disabled,
  label,
  detail,
  suggested = false,
  onChange,
}: {
  type: "radio" | "checkbox";
  name: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  detail?: string;
  suggested?: boolean;
  onChange: () => void;
}) {
  return (
    <label className={`clarify-option${checked ? " is-picked" : ""}`}>
      <input type={type} name={name} checked={checked} disabled={disabled} onChange={onChange} />
      <span className="clarify-option-mark" data-type={type} aria-hidden="true">
        {type === "checkbox" && checked && <Check size={13} strokeWidth={3} />}
      </span>
      <span className="clarify-option-copy">
        <strong>{label}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {suggested && <span className="clarify-option-tag">Suggested</span>}
    </label>
  );
}

/** The user's own words for "Something else". Enter moves on. */
function OtherAnswer({
  question,
  draft,
  disabled,
  onDraft,
  onEnter,
}: {
  question: ClarifyQuestion;
  draft: ClarifyDraft;
  disabled: boolean;
  onDraft: (draft: ClarifyDraft) => void;
  onEnter: () => void;
}) {
  return (
    <input
      className="clarify-other-input"
      type="text"
      autoFocus
      aria-label={`Your answer: ${question.question}`}
      placeholder="Type your answer"
      value={draft[question.id]?.other ?? ""}
      disabled={disabled}
      onChange={(event) => onDraft(typeOther(draft, question, event.target.value))}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

function QuestionBlock({
  question,
  draft,
  disabled,
  focusFirst,
  onDraft,
  onEnter,
}: {
  question: ClarifyQuestion;
  draft: ClarifyDraft;
  disabled: boolean;
  /** Moving to this question puts the keyboard on its first option. */
  focusFirst: boolean;
  onDraft: (draft: ClarifyDraft) => void;
  onEnter: () => void;
}) {
  const name = useId();
  const firstOption = useRef<HTMLDivElement | null>(null);
  const type = question.multiple ? "checkbox" : "radio";
  const otherOn = otherIsOn(draft, question);
  useEffect(() => {
    if (focusFirst) firstOption.current?.querySelector("input")?.focus();
  }, [focusFirst, question.id]);
  return (
    <fieldset className="clarify-question" disabled={disabled}>
      <legend>{question.question}</legend>
      {question.multiple && <p className="clarify-question-hint">Choose any that apply.</p>}
      <div className="clarify-options" ref={firstOption}>
        {question.options.map((option, index) => (
          <OptionRow
            key={option.label}
            type={type}
            name={name}
            checked={isPicked(draft, question, option.label)}
            disabled={disabled}
            label={option.label}
            detail={option.detail}
            suggested={question.recommended === index}
            onChange={() => onDraft(pickOption(draft, question, option.label))}
          />
        ))}
        <OptionRow
          type={type}
          name={name}
          checked={otherOn}
          disabled={disabled}
          label="Something else"
          onChange={() => onDraft(pickOther(draft, question))}
        />
        {otherOn && (
          <OtherAnswer question={question} draft={draft} disabled={disabled} onDraft={onDraft} onEnter={onEnter} />
        )}
      </div>
    </fieldset>
  );
}

/** What was asked, once the conversation moved on without an answer. */
function PassedQuestions({ questions }: { questions: ClarifyQuestion[] }) {
  return (
    <>
      <ul className="clarify-asked">
        {questions.map((question) => (
          <li key={question.id}>{question.question}</li>
        ))}
      </ul>
      <p className="clarify-note">You replied in the chat instead, so these were left unanswered.</p>
    </>
  );
}

/** Next (Continue on the last question, once anything is answered), Decide
 * for me, and Back after the first question. */
function CardActions({
  last,
  canSend,
  disabled,
  onForward,
  onDecide,
  onBack,
}: {
  last: boolean;
  canSend: boolean;
  disabled: boolean;
  onForward: () => void;
  onDecide: () => void;
  onBack?: () => void;
}) {
  const ForwardIcon = last ? Check : ArrowRight;
  return (
    <div className="draft-handoff-actions">
      <button
        type="button"
        className="draft-handoff-choice is-primary"
        disabled={disabled || (last && !canSend)}
        onClick={onForward}
      >
        <ForwardIcon size={17} aria-hidden="true" />
        <span>{last ? "Continue" : "Next"}</span>
      </button>
      <button type="button" className="draft-handoff-choice" disabled={disabled} onClick={onDecide}>
        <Sparkles size={17} aria-hidden="true" />
        <span>Decide for me</span>
      </button>
      {onBack && (
        <button type="button" className="draft-handoff-edit" disabled={disabled} onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          <span>Back</span>
        </button>
      )}
    </div>
  );
}

/** The questions, one at a time, and the user's picks so far. */
function AnswerSteps({
  questions,
  disabled,
  onRespond,
  onAlwaysDecide,
}: {
  questions: ClarifyQuestion[];
  disabled: boolean;
  onRespond: (response: ClarifyResponse) => void;
  onAlwaysDecide?: () => void;
}) {
  const [draft, setDraft] = useState<ClarifyDraft>({});
  const [step, setStep] = useState({ index: 0, moved: false });
  const question = questions[Math.min(step.index, questions.length - 1)]!;
  const last = step.index >= questions.length - 1;
  const answers = draftAnswers(draft, questions);
  const goTo = (index: number) => setStep({ index, moved: true });
  const submit = () => {
    if (!disabled && answers.length > 0) onRespond({ kind: "answers", answers });
  };
  const forward = () => (last ? submit() : goTo(step.index + 1));
  const several = questions.length > 1;
  return (
    <>
      {several && (
        <p className="clarify-step">
          Question {step.index + 1} of {questions.length}
        </p>
      )}
      <QuestionBlock
        key={question.id}
        question={question}
        draft={draft}
        disabled={disabled}
        focusFirst={step.moved}
        onDraft={setDraft}
        onEnter={forward}
      />
      <CardActions
        last={last}
        canSend={answers.length > 0}
        disabled={disabled}
        onForward={forward}
        onDecide={() => onRespond({ kind: "decide" })}
        onBack={step.index > 0 ? () => goTo(step.index - 1) : undefined}
      />
      <p className="clarify-note">
        {several ? "Skip a question and the assistant decides it. " : ""}
        {onAlwaysDecide && (
          <button type="button" className="clarify-always" disabled={disabled} onClick={onAlwaysDecide}>
            Always decide for me
          </button>
        )}
      </p>
    </>
  );
}

/** The questions a reply paused on. The user picks options, types their own
 * answer, or lets the assistant decide; the reply then carries on. A question
 * skipped with Next is left to the assistant. */
export function ClarifyCard({
  clarification,
  brandName,
  state,
  onRespond,
  onAlwaysDecide,
}: {
  clarification: WaitingClarification;
  brandName: string;
  state: ClarifyCardState;
  onRespond: (response: ClarifyResponse) => void;
  /** Turns asking off for later replies, then lets the assistant decide this one. */
  onAlwaysDecide?: () => void;
}) {
  const headingId = useId();
  const assistantName = brandName || "The assistant";
  const asked = questionsPhrase(clarification.questions.length);
  return (
    <section className={`draft-handoff-card clarify-card is-${state}`} aria-labelledby={headingId}>
      {state === "open" && (
        <span className="sr-only" role="status">
          {`${assistantName} paused to ask you ${asked}.`}
        </span>
      )}
      <div className="draft-handoff-head">
        <span className="draft-handoff-icon" aria-hidden="true">
          <MessageCircleQuestion size={20} />
        </span>
        <div className="draft-handoff-copy">
          <h3 id={headingId}>{`${assistantName} has ${asked} before going on`}</h3>
          <p>{clarification.intro || "Pick an answer, type your own, or let it decide."}</p>
        </div>
      </div>
      {state === "passed" ? (
        <PassedQuestions questions={clarification.questions} />
      ) : (
        <AnswerSteps
          questions={clarification.questions}
          disabled={state !== "open"}
          onRespond={onRespond}
          onAlwaysDecide={onAlwaysDecide}
        />
      )}
    </section>
  );
}
