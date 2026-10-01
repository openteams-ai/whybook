"""A question about a point or an area of a picture, with the fake Agent SDK of test_claude:
no call reaches Claude.

The solve request carries the picture, and the point or the area as fractions of the
picture and in its pixels. The server sends the picture through the SDK's streaming
input: one user message whose content is an image block, then the prompt as text.
"""

import base64
import io
import json
import sys

import pytest

from whybook.server.config import Whybook
from whybook.server.questions.models import InvalidRequest
from whybook.server.solve import SolveRequest, solve
from whybook.server.tests.test_claude import CELL, FakeSDKError, ResultMessage, fake_sdk

QUESTION = {"text": "What does the plot show here?", "type": "descriptive"}


def png(width=40, height=20):
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def request(**image):
    picture = {"mime": "image/png", "data": png(), "width": 40, "height": 20, "point": {"x": 10, "y": 5, "fx": 0.25, "fy": 0.25}}
    picture.update(image)
    body = {
        "question": QUESTION,
        "placement": "new",
        "cell": {"label": "[3]", "source": "plt.plot(df.x, df.y)"},
        "about": "the point 25% across and 25% down the picture that cell [3] shows (pixel x 10, y 5 of 40 by 20 px, from the top left)",
        "image": picture,
    }
    return SolveRequest.from_json(body)


async def sent(monkeypatch, solve_request, replies):
    sdk = fake_sdk(replies)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    events = [event async for event in solve(solve_request, Whybook())]
    # The prompt of each call, as the CLI would read it from the SDK.
    prompts = []
    for call in sdk.calls:
        prompt = call["prompt"]
        prompts.append(prompt if isinstance(prompt, str) else [message async for message in prompt])
    return events, prompts


async def test_the_picture_goes_to_claude_as_an_image_block_before_the_prompt(monkeypatch):
    solve_request = request()
    events, prompts = await sent(monkeypatch, solve_request, [ResultMessage(structured_output=CELL)])
    assert events[-1]["type"] == "result"
    ((message,),) = prompts
    assert (message["type"], message["message"]["role"]) == ("user", "user")
    image, text = message["message"]["content"]
    assert image == {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": solve_request.image["data"]}}
    assert text["type"] == "text"
    body = json.loads(text["text"])
    # The model reads no position from a picture: the text gives it, in pixels and as fractions.
    assert body["image"] == {"width": 40, "height": 20, "point": {"x": 10, "y": 5, "fx": 0.25, "fy": 0.25}}
    assert body["about"].startswith("the point 25% across and 25% down")
    assert solve_request.image["data"] not in text["text"]


async def test_an_area_goes_with_its_corners(monkeypatch):
    box = {"x0": 4, "y0": 2, "x1": 20, "y1": 10, "fx0": 0.1, "fy0": 0.1, "fx1": 0.5, "fy1": 0.5}
    _, prompts = await sent(monkeypatch, request(point=None, box=box), [ResultMessage(structured_output=CELL)])
    ((message,),) = prompts
    assert json.loads(message["message"]["content"][-1]["text"])["image"] == {"width": 40, "height": 20, "box": box}


async def test_the_retry_as_plain_json_sends_the_picture_again(monkeypatch):
    failure = FakeSDKError("Claude Code returned an error result: Failed to provide valid structured output after 5 attempts")
    reply = ResultMessage(result=json.dumps(CELL))
    events, prompts = await sent(monkeypatch, request(), [failure, reply])
    assert events[-1]["type"] == "result"
    assert [[block["type"] for block in messages[0]["message"]["content"]] for messages in prompts] == [["image", "text"], ["image", "text"]]
    assert prompts[1][0]["message"]["content"][-1]["text"].endswith("no prose and no code fence.")


async def test_a_question_without_a_picture_sends_text_as_before(monkeypatch):
    plain = SolveRequest.from_json({"question": QUESTION, "placement": "new"})
    assert plain.images() == []
    _, prompts = await sent(monkeypatch, plain, [ResultMessage(structured_output=CELL)])
    assert prompts == [plain.prompt()]
    assert "image" not in json.loads(plain.prompt())


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"mime": "image/svg+xml"}, "image must be one of"),
        ({"data": "<svg/>"}, "image data must be base64"),
        ({"width": 0}, "image width must be a positive whole number"),
        ({"point": None}, "image needs a point or a box"),
        ({"box": {"x0": 1}}, "image needs a point or a box"),
        ({"point": {"x": 1, "y": 1, "fx": "0.1", "fy": 0.1}}, "point fx must be a number"),
    ],
)
def test_a_picture_that_claude_cannot_read_is_refused(change, message):
    with pytest.raises(InvalidRequest, match=message):
        request(**change)


def test_a_picture_over_5_mb_is_refused(monkeypatch):
    monkeypatch.setattr("whybook.server.solve.MAX_IMAGE_BYTES", 10)
    with pytest.raises(InvalidRequest, match="larger than 5 MB"):
        request()
