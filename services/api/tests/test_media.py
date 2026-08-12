from __future__ import annotations

import pytest

from app.core.media import (
    MediaProcessingError,
    classify_media,
    direct_audio_format,
    prepare_media_audio,
)


def test_classify_audio_and_video_by_name_and_mime() -> None:
    assert classify_media("notes.mp3", "audio/mpeg").is_audio
    assert classify_media("standup.mp4", "video/mp4").is_video
    assert classify_media("clip.webm", "audio/webm").is_audio
    assert classify_media("clip.webm", "video/webm").is_video
    assert not classify_media("brief.pdf", "application/pdf").is_media


def test_direct_wav_and_mp3_skip_ffmpeg() -> None:
    prepared = prepare_media_audio(b"RIFF-fake-wav-bytes", "dictation.wav", "audio/wav")
    assert prepared.used_ffmpeg is False
    assert prepared.audio_format == "wav"
    assert prepared.chunks == (b"RIFF-fake-wav-bytes",)

    prepared_mp3 = prepare_media_audio(b"id3-fake-mp3", "call.mp3", "audio/mpeg")
    assert prepared_mp3.used_ffmpeg is False
    assert prepared_mp3.audio_format == "mp3"


def test_video_without_ffmpeg_fails_honestly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.core.media.ffmpeg_available", lambda: False)
    with pytest.raises(MediaProcessingError, match="cannot process this media format"):
        prepare_media_audio(b"fake-mp4-bytes", "meeting.mp4", "video/mp4")


def test_video_without_audio_still_extracts_frames(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.core.media.ffmpeg_available", lambda: True)
    monkeypatch.setattr("app.core.media.probe_duration_seconds", lambda source: 10.0)
    monkeypatch.setattr("app.core.media._extract_mp3", lambda source, dest: False)
    monkeypatch.setattr(
        "app.core.media._extract_frames",
        lambda source, tmp, duration: (b"jpeg-bytes",),
    )
    prepared = prepare_media_audio(b"fake-mp4-bytes", "silent.mp4", "video/mp4")
    assert prepared.had_audio_track is False
    assert prepared.chunks == ()
    assert prepared.frames == (b"jpeg-bytes",)


def test_video_without_audio_or_frames_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.core.media.ffmpeg_available", lambda: True)
    monkeypatch.setattr("app.core.media.probe_duration_seconds", lambda source: 10.0)
    monkeypatch.setattr("app.core.media._extract_mp3", lambda source, dest: False)
    monkeypatch.setattr("app.core.media._extract_frames", lambda source, tmp, duration: ())
    with pytest.raises(MediaProcessingError, match="no still frames"):
        prepare_media_audio(b"fake-mp4-bytes", "silent.mp4", "video/mp4")


def test_direct_audio_format_map() -> None:
    assert direct_audio_format("a.wav", "audio/wav") == "wav"
    assert direct_audio_format("a.mp3", None) == "mp3"
    assert direct_audio_format("a.mp4", "video/mp4") is None
