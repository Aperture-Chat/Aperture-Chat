"""Which image model draws a chat picture when no licensed photo exists."""

from app.core.image_model_rank import image_model_rank


def test_image_models_rank_gemini_first_then_the_backup_order() -> None:
    ranked = sorted(
        [
            "gpt-image-1",
            "google/gemini-3.1-flash-image-preview",
            "gpt-image-2.5-sunburst",
            "google/gemini-3-pro-image-preview",
            "gpt-image-2",
            "MAI-Image-2.6",
            "openai/gpt-image-1-mini",
            "some-unknown-image",
        ],
        key=image_model_rank,
        reverse=True,
    )

    assert ranked == [
        "google/gemini-3-pro-image-preview",
        "google/gemini-3.1-flash-image-preview",
        "gpt-image-2.5-sunburst",
        "gpt-image-2",
        "MAI-Image-2.6",
        "gpt-image-1",
        "openai/gpt-image-1-mini",
        "some-unknown-image",
    ]


def test_an_unknown_or_missing_model_ranks_last() -> None:
    assert image_model_rank(None) == 0
    assert image_model_rank("gpt-image-2-mini") == 0


def test_newer_gemini_image_models_rank_above_older_ones() -> None:
    newest_first = [
        "google/gemini-3-pro-image-preview",
        "google/gemini-2.5-pro-image",
        "google/gemini-3.1-flash-image-preview",
        "google/gemini-3-flash-image",
        "google/gemini-2.5-flash-image",
        "google/gemini-flash-image",
        "gpt-image-2.5",
    ]
    ranks = [image_model_rank(model) for model in newest_first]

    assert all(better > worse for better, worse in zip(ranks, ranks[1:])), ranks


def test_an_id_with_spaces_or_capitals_ranks_like_the_plain_id() -> None:
    assert image_model_rank("  OpenAI/GPT-Image-2  ") == image_model_rank("gpt-image-2") > 0
