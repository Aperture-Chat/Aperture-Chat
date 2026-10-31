import { ChatRequestError } from "./api/http";

/** What went wrong, in words that are true, with only the steps that can work. */
export type ViewerFailure = {
  title: string;
  detail: string;
  retry: boolean;
  download: boolean;
  /** Nothing is broken: the document is simply gone. Not announced as an alert. */
  calm: boolean;
};

export type OpeningKind = "document" | "chunk";
export type ShownThing = "pages" | "image";

const SESSION_ENDED: ViewerFailure = {
  title: "Your session has ended",
  detail: "Sign in again, then reopen this source.",
  retry: false,
  download: false,
  calm: false,
};

const NO_ACCESS: ViewerFailure = {
  title: "You do not have access to this document",
  detail: "Ask your administrator if you need it.",
  retry: false,
  download: false,
  calm: false,
};

const GONE: Record<OpeningKind, ViewerFailure> = {
  document: {
    title: "This document is no longer available",
    detail: "It may have been removed from the knowledge base, or you may no longer have access to it.",
    retry: false,
    download: false,
    calm: true,
  },
  chunk: {
    title: "This passage is no longer available",
    detail: "Its document may have been updated or removed, or you may no longer have access to it.",
    retry: false,
    download: false,
    calm: true,
  },
};

const PASSWORD_PROTECTED: ViewerFailure = {
  title: "This PDF is protected by a password",
  detail: "It cannot be shown here. Download the original to open it.",
  retry: false,
  download: true,
  calm: false,
};

const DAMAGED: ViewerFailure = {
  title: "This PDF is damaged",
  detail: "It cannot be shown here. The original may still open in another program.",
  retry: false,
  download: true,
  calm: false,
};

function statusOf(error: unknown): number | undefined {
  return error instanceof ChatRequestError ? error.status : undefined;
}

function responseFailure(status: number | undefined, kind: OpeningKind): ViewerFailure | null {
  if (status === 401) return SESSION_ENDED;
  if (status === 403) return NO_ACCESS;
  return status === 404 ? GONE[kind] : null;
}

/** A failure opening the document's details. */
export function requestFailure(error: unknown, kind: OpeningKind): ViewerFailure {
  return (
    responseFailure(statusOf(error), kind) ?? {
      title: "This document could not be opened",
      detail: "Check your connection and try again.",
      retry: true,
      download: true,
      calm: false,
    }
  );
}

function fileProblem(error: unknown): ViewerFailure | null {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") return PASSWORD_PROTECTED;
  return name === "InvalidPDFException" || name === "FormatError" ? DAMAGED : null;
}

/** A failure fetching or reading the bytes. Only pdf.js can say a file is
 * protected or damaged; a failed request says nothing about the file. */
export function fileFailure(error: unknown, shown: ShownThing): ViewerFailure {
  return (
    fileProblem(error) ??
    responseFailure(statusOf(error), "document") ?? {
      title: shown === "image" ? "The image could not be shown" : "The pages could not be shown",
      detail: "Check your connection and try again.",
      retry: true,
      download: true,
      calm: false,
    }
  );
}
