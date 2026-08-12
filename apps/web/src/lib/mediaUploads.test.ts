import { describe, expect, test } from "vitest";
import { isMediaUploadFile, MEDIA_UPLOAD_EXTENSIONS } from "./mediaUploads";

describe("media upload detection", () => {
  test("recognizes common audio and video files", () => {
    expect(isMediaUploadFile({ name: "call.mp3", type: "audio/mpeg" })).toBe(true);
    expect(isMediaUploadFile({ name: "meeting.mp4", type: "video/mp4" })).toBe(true);
    expect(isMediaUploadFile({ name: "clip.webm", type: "video/webm" })).toBe(true);
    expect(isMediaUploadFile({ name: "brief.pdf", type: "application/pdf" })).toBe(false);
  });

  test("includes audio and video extensions for knowledge accept lists", () => {
    expect(MEDIA_UPLOAD_EXTENSIONS).toContain(".mp3");
    expect(MEDIA_UPLOAD_EXTENSIONS).toContain(".mp4");
    expect(MEDIA_UPLOAD_EXTENSIONS).toContain(".wav");
  });
});
