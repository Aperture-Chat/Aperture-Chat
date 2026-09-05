"""Lightweight source-rewrite regression; no synthesis dependencies required."""
import importlib.util
from pathlib import Path
import unittest
import tempfile

spec = importlib.util.spec_from_file_location(
    "training_narration", Path(__file__).with_name("generate-training-narration.py")
)
narration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(narration)


class NarrationRewriteTest(unittest.TestCase):
    def test_missing_audio_mapping_and_existing_duration_update_together(self):
        source = 'title: "Preview", durationSeconds: 12'
        duration_start = source.index("12")
        result = narration.apply_replacements(source, [
            ([duration_start, duration_start + 2], "29"),
            ((0, 0), 'audioSrc: "training/user/chat-previews.mp3", '),
        ])
        self.assertEqual(
            result,
            'audioSrc: "training/user/chat-previews.mp3", title: "Preview", durationSeconds: 29',
        )

    def test_partial_regeneration_preserves_unselected_manifest_evidence(self):
        old = [
            {"deck": "user", "video": "keep.mp3", "scene": 0},
            {"deck": "user", "video": "replace.mp3", "scene": 0},
            {"deck": "user", "video": "replace.mp3", "scene": 1},
        ]
        replacement = {"deck": "user", "video": "replace.mp3", "scene": 0, "narration": "New text"}
        self.assertEqual(narration.merge_manifest(old, [replacement], {"replace.mp3"}), [old[0], replacement])

    def test_concurrent_source_edits_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.tsx"
            path.write_text("someone else's edits")
            staged = Path(directory) / "staged.mp3"
            published = Path(directory) / "published.mp3"
            staged.write_bytes(b"new audio")
            published.write_bytes(b"previous audio")
            with self.assertRaisesRegex(RuntimeError, "source changed"):
                narration.write_deck_if_unchanged(path, "original snapshot", [((0, 0), "generated")], [(staged, published)])
            self.assertEqual(path.read_text(), "someone else's edits")
            self.assertEqual(published.read_bytes(), b"previous audio")
            self.assertEqual(staged.read_bytes(), b"new audio")

    def test_verified_source_and_staged_audio_publish_together(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.tsx"
            path.write_text("old")
            staged = Path(directory) / "staged.mp3"
            published = Path(directory) / "published.mp3"
            staged.write_bytes(b"new audio")
            published.write_bytes(b"previous audio")
            narration.write_deck_if_unchanged(path, "old", [((0, 3), "new")], [(staged, published)])
            self.assertEqual(path.read_text(), "new")
            self.assertEqual(published.read_bytes(), b"new audio")
            self.assertFalse(staged.exists())


if __name__ == "__main__":
    unittest.main()
