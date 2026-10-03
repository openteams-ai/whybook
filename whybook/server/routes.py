import asyncio
import dataclasses
import json
import sqlite3
from typing import Any, AsyncIterator

import html

import tornado
from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.utils import url_path_join
from tornado.iostream import StreamClosedError
from tornado.web import HTTPError

from . import agent, cell_titles, connection, databases, dependencies, frame_notes, library_defaults, local_models, model_client, privacy, providers, signin, sorting, speech, table_notes, tiers
from .keystore import KeyStore
from .config import Whybook
from .questions import claude_questions, ranking, review, templates, values
from .questions.cells import CellInfo, Decision, cell_questions, decision_options, next_steps, suggested_values
from .questions.drops import DropRequest, drop_options
from .questions.files import FileDrop, file_options
from .questions.tables import TableDrop, table_options
from .questions.models import Context, InvalidRequest, Selection
from .solve import SolveRequest, solve


class BaseHandler(APIHandler):
    def initialize(self, config: Whybook):
        self.future_config = config

    def get_json_body(self) -> Any:
        try:
            body = json.loads(self.request.body or b"{}")
        except ValueError as error:
            raise HTTPError(400, "the body must be JSON") from error
        # What the view chose for the calls of this request, such as zero data
        # retention turned off: the calls read it from this request's config.
        self.future_config = connection.for_request(self.future_config, body)
        return body

    def read_selection(self) -> tuple[Selection, Context]:
        body = self.get_json_body()
        if not isinstance(body, dict):
            raise HTTPError(400, "the body must be an object")
        try:
            return Selection.from_json(body.get("selection")), Context.from_json(body.get("context"))
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error

    def check_failed(self, error: providers.ProviderError, saved: dict[str, Any] | None) -> None:
        """Answer 409 when a provider did not take a key or list its models: the words, how the check ended, and when the key that stays in use was saved.

        ``check`` is "refused", "unchecked" or null (providers.ProviderError),
        so that the panel offers Try again, and Save anyway or Save without a
        check. The words never hold the key.
        """
        self.set_status(409)
        self.finish(json.dumps({"message": str(error), "check": error.check, "saved": (saved or {}).get("saved")}))

    async def stream(self, events: AsyncIterator[dict[str, Any]]) -> None:
        """Send events as newline-delimited JSON, one line per event."""
        self.set_header("Content-Type", "application/x-ndjson")
        self.set_header("Cache-Control", "no-cache")
        try:
            async for event in events:
                self.write(json.dumps(event) + "\n")
                await self.flush()
        except StreamClosedError:
            # The user closed the view: stop the call to Claude.
            return
        finally:
            await events.aclose()
        self.finish()


def refuse_without_remote(config: Whybook) -> None:
    """Refuse a request for the remote model with 409 when it cannot answer, saying why and how to set it up."""
    remote = connection.readiness(config)
    if not remote["available"]:
        raise HTTPError(409, f"No AI model answers on this server: {remote['reason']}. {remote['setup']}")


def json_check_of(body: Any) -> str:
    """How a local model's answer is held to its JSON rules, as the view's settings chose: local_models.JSON_CHECKS."""
    check = (body.get("json_check") if isinstance(body, dict) else None) or "fast"
    if check not in local_models.JSON_CHECKS:
        raise HTTPError(400, f"unknown JSON check {check!r}")
    return check


def local_model_of(body: Any) -> str | None:
    """The id of the local model that a request names, or None.

    A request for a model of the settings carries its spec (model_spec), which
    registers it again after the server restarts; a spec that is wrong is 400.
    """
    if not isinstance(body, dict):
        return None
    try:
        model = local_models.model_of(body.get("model"), body.get("model_spec"))
    except local_models.LocalModelError as error:
        raise HTTPError(400, str(error)) from error
    return model.id if model else None


async def plain_errors(events: AsyncIterator[dict[str, Any]], config: Whybook) -> AsyncIterator[dict[str, Any]]:
    """The events of a run, with the known failures of the remote model in plain words."""
    try:
        async for event in events:
            if event.get("type") == "error" and isinstance(event.get("message"), str):
                event = {**event, "message": connection.reason(event["message"], config)}
            yield event
    finally:
        await events.aclose()


class StatusHandler(BaseHandler):
    """What the server can run. A POST carries the local models of the view's
    settings (custom_local_models), which the status then lists after the five."""

    @tornado.web.authenticated
    def get(self):
        self.finish(json.dumps(self.status()))

    @tornado.web.authenticated
    def post(self):
        body = self.get_json_body()
        problems = local_models.register_custom(body.get("custom_local_models") if isinstance(body, dict) else None)
        self.finish(json.dumps({**self.status(), "custom_model_problems": problems}))

    def status(self) -> dict[str, Any]:
        config = self.future_config
        # The connected model, read without a call to it: for the Claude Code
        # login the SDK, its CLI and a credential; for another provider a key
        # and a chosen model. The names are older than the connection.
        remote = connection.readiness(config)
        return {
            "ranker": config.question_ranker,
            "jev_configured": config.jev_configured,
            "claude_available": remote["available"],
            "claude": remote,
            "describe_tables": config.describe_tables,
            "remote_model": None if remote["provider"] == "none" else remote["model"] if remote["provider"] == "claude-code" else remote["label"],
            "local_models": local_models.status(),
            "speech_engines": speech.status(),
            "json_check_warning": local_models.fast_check_warning(),
            "keep_data_local": config.keep_data_local,
            # True when the server pins zero data retention on OpenRouter for every user.
            "openrouter_zdr": config.openrouter_zdr,
            # The connected provider's models for the tasks that need speed: tiers.py.
            "remote_tiers": tiers.recommended(remote["provider"]),
            "jev": sorting.jev_status(config),
        }


def for_kernel(result: dict[str, Any], context: Context) -> dict[str, Any]:
    """The options of a drop, without the templates' code in a kernel of another language than Python."""
    return {**result, "options": context.for_kernel(result.get("options") or [])}


class DropHandler(BaseHandler):
    """Options for a drop, or for a click on a source and then a target."""

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        try:
            kind = (body.get("source") or {}).get("kind") if isinstance(body, dict) else None
            root = getattr(self.contents_manager, "root_dir", None)
            if kind == "file":
                # A file from the file browser: its path is in the server's contents.
                file = FileDrop.from_json(body)
                self.finish(json.dumps(for_kernel(file_options(file, root), file.context)))
                return
            if kind == "table":
                # A table from the Databases panel; reading its schema blocks.
                table = TableDrop.from_json(body)
                result = await asyncio.to_thread(table_options, table, root)
                self.finish(json.dumps(for_kernel(result, table.context)))
                return
            request = DropRequest.from_json(body)
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        self.finish(json.dumps(for_kernel(drop_options(request), request.context)))


class DatabasesHandler(BaseHandler):
    """The SQLite files under the server's root."""

    @tornado.web.authenticated
    async def get(self):
        root = getattr(self.contents_manager, "root_dir", None)
        if root is None:
            self.finish(json.dumps({"databases": [], "complete": True, "depth": 0}))
            return
        self.finish(json.dumps(await asyncio.to_thread(databases.discover, root)))


class DatabaseTablesHandler(BaseHandler):
    """The tables of one SQLite file, with columns and row counts."""

    @tornado.web.authenticated
    async def get(self):
        root = getattr(self.contents_manager, "root_dir", None)
        path = self.get_query_argument("path", "")
        if root is None or not path:
            raise HTTPError(400, "a database path is needed")
        try:
            described = await asyncio.to_thread(databases.describe, root, path)
        except databases.OutsideRoot as error:
            raise HTTPError(403, "the path leaves the server's root") from error
        except (ValueError, sqlite3.Error) as error:
            raise HTTPError(400, str(error)) from error
        self.finish(json.dumps(described))


class DependenciesHandler(BaseHandler):
    """The cells to run so that some names exist in the kernel, read from the source."""

    @tornado.web.authenticated
    def post(self):
        try:
            self.finish(json.dumps(dependencies.plan_from_json(self.get_json_body())))
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error


class ClaudeDependenciesHandler(BaseHandler):
    """Claude's reading, for the names the source did not explain."""

    @tornado.web.authenticated
    async def post(self):
        try:
            prompt, order = dependencies.claude_request(self.get_json_body())
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        await self.stream(dependencies.ask_claude(prompt, order, self.future_config))


class TableNotesHandler(BaseHandler):
    """A description and a headline for tables the bench shows as tiles, from Claude or a local model."""

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        model = (body.get("model") if isinstance(body, dict) else None) or "remote"
        try:
            tables = table_notes.tables_from_json(body)
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        if local_model_of(body):
            # The tables stay on the machine, so c.Whybook.describe_tables does not apply.
            await self.stream(local_models.ask_local(model, tables, self.future_config.local_threads, json_check_of(body)))
            return
        if not tiers.is_remote(model):
            raise HTTPError(400, f"unknown model {model!r}")
        if privacy.keep_local_for_remote(self.future_config, body):
            raise HTTPError(409, privacy.TABLES_REFUSED)
        if not self.future_config.describe_tables and not connection.runs_locally(self.future_config):
            raise HTTPError(403, "table descriptions by the remote model are turned off: c.Whybook.describe_tables")
        prompt = table_notes.prompt_of(tables)
        await self.stream(table_notes.ask_claude(prompt, [table["id"] for table in tables], self.future_config))


class FrameNotesHandler(BaseHandler):
    """A summary of one sentence for data frames that Contents shows, from Claude or a local model."""

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        model = (body.get("model") if isinstance(body, dict) else None) or "remote"
        try:
            frames = frame_notes.frames_from_json(body)
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        if local_model_of(body):
            await self.stream(local_models.ask_local_frames(model, frames, self.future_config.local_threads, json_check_of(body)))
            return
        if not tiers.is_remote(model):
            raise HTTPError(400, f"unknown model {model!r}")
        if not self.future_config.describe_tables and not connection.runs_locally(self.future_config):
            raise HTTPError(403, "labels and captions by the remote model are turned off: c.Whybook.describe_tables")
        prompt = frame_notes.prompt_of(frames)
        await self.stream(frame_notes.ask_claude(prompt, [frame["id"] for frame in frames], self.future_config))


class CellTitlesHandler(BaseHandler):
    """A title of a few words for code cells that the analyst edited, from Claude or a local model."""

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        model = (body.get("model") if isinstance(body, dict) else None) or "remote"
        try:
            cells = cell_titles.cells_from_json(body)
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        if local_model_of(body):
            await self.stream(local_models.ask_local_titles(model, cells, self.future_config.local_threads, json_check_of(body)))
            return
        if not tiers.is_remote(model):
            raise HTTPError(400, f"unknown model {model!r}")
        if not self.future_config.describe_tables and not connection.runs_locally(self.future_config):
            raise HTTPError(403, "labels and captions by the remote model are turned off: c.Whybook.describe_tables")
        prompt = cell_titles.prompt_of(cells)
        await self.stream(cell_titles.ask_claude(prompt, [cell["id"] for cell in cells], self.future_config))


class ModelDownloadHandler(BaseHandler):
    """Fetch a local model's pinned file, when the user presses Download for it."""

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        model = local_model_of(body)
        if model is None:
            raise HTTPError(400, f"unknown model {body.get('model') if isinstance(body, dict) else None!r}")
        await self.stream(local_models.download(model))


class SpeechTranscribeHandler(BaseHandler):
    """The words of a spoken question: the body is a WAV file of 16-bit mono PCM,
    the query names the engine and the names to favour, one ``term`` each."""

    @tornado.web.authenticated
    async def post(self):
        engine = self.get_query_argument("engine", "")
        try:
            result = await speech.ask_transcribe(engine, self.request.body, self.get_query_arguments("term"))
        except speech.SpeechError as error:
            raise HTTPError(error.status, str(error)) from error
        except Exception as error:  # noqa: BLE001  the engine's failure goes to the view
            raise HTTPError(502, f"{engine} could not transcribe the recording: {error}") from error
        self.finish(json.dumps(result))


class SpeechDownloadHandler(BaseHandler):
    """Fetch a speech engine's model, when the user presses Download for it."""

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        engine = body.get("engine") if isinstance(body, dict) else None
        if engine not in speech.ENGINES:
            raise HTTPError(400, f"unknown speech engine {engine!r}")
        await self.stream(speech.download(engine))


class CellQuestionsHandler(BaseHandler):
    """Questions about one selected cell, or about how several cells relate."""

    @tornado.web.authenticated
    def post(self):
        body = self.get_json_body()
        try:
            cells = [CellInfo.from_json(cell) for cell in body.get("cells") or []]
            context = Context.from_json(body.get("context"))
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        if not cells:
            raise HTTPError(400, "select at least one cell")
        questions = cell_questions(cells, context)
        self.finish(json.dumps({"questions": context.for_kernel([question.to_json() for question in questions])}))


class DecisionHandler(BaseHandler):
    """What-if branches for one decision of a cell, from its chip."""

    @tornado.web.authenticated
    def post(self):
        body = self.get_json_body()
        try:
            if not isinstance(body, dict) or not isinstance(body.get("cell"), dict):
                raise InvalidRequest("the body needs a cell and a decision")
            value = body.get("value")
            decision = Decision.from_json(body.get("decision"))
            result = decision_options(
                CellInfo.from_json(body["cell"]),
                decision,
                Context.from_json(body.get("context")),
                str(value) if value is not None else None,
                # The calls the value goes into, such as one merge of two; all of them without it.
                decision.chosen_calls(body.get("calls")),
                # The values that a model suggested (DecisionValuesHandler), in place of the rules'.
                suggested_values(body.get("suggested")),
            )
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        self.finish(json.dumps(result))


class DecisionValuesHandler(BaseHandler):
    """Other values of a constant from the model chosen for More questions, when no rule knows the kind of the constant.

    The result event has the model's ``kind`` and ``values``, each a value as
    Python code and why; the view then asks DecisionHandler for their branches.
    With the data on this machine, a model elsewhere reads the name and the
    code without the value (privacy.without_value).
    """

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        try:
            if not isinstance(body, dict) or not isinstance(body.get("cell"), dict):
                raise InvalidRequest("the body needs a cell and a decision")
            decision = Decision.from_json(body.get("decision"))
            cell = CellInfo.from_json(body["cell"])
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        if privacy.looks_secret(decision.name, decision.value):
            raise HTTPError(400, "a key or a token is no choice to try")
        where = f"{decision.source_file}:{decision.source_line}" if decision.source_file and decision.source_line else decision.source_file
        about = (decision.name, decision.value, decision.param, decision.function, decision.provenance, where, cell.source)
        model = body.get("model") or "remote"
        if local_model_of(body):
            await self.stream(values.local_values(model, *about, self.future_config.local_threads, json_check_of(body)))
            return
        if not tiers.is_remote(model):
            raise HTTPError(400, f"unknown model {model!r}")
        keep = privacy.keep_local_for_remote(self.future_config, body)
        await self.stream(plain_errors(values.model_values(*about, self.future_config, keep), self.future_config))


class LibraryDefaultsHandler(BaseHandler):
    """The defaults that models picked from the signatures of library functions, as the server keeps them: no model is asked.

    ``{"functions": [...]}``, as the kernel lists them; the answer holds the
    functions that have a kept answer (library_defaults.kept).
    """

    @tornado.web.authenticated
    async def post(self):
        try:
            functions = library_defaults.functions_from_json(self.get_json_body())
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        self.finish(json.dumps({"answers": await asyncio.to_thread(library_defaults.kept, functions)}))


class LibraryDefaultsAskHandler(BaseHandler):
    """The model chosen for More questions picks, from one function's signature, the defaults that can change a result.

    ``{"function", "model"}``. The server keeps the answer for the library's
    version, and a function whose answer it kept gets that answer as a result
    with ``"kept": true``, and no call. With the data on this machine, a
    model elsewhere does not read the value of a default that holds data.
    """

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        try:
            function = library_defaults.Function.from_json(body.get("function") if isinstance(body, dict) else None)
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        answered = await asyncio.to_thread(library_defaults.kept, [function])
        if answered:
            await self.stream(library_defaults.kept_answer(answered[0]))
            return
        model = body.get("model") or "remote"
        if local_model_of(body):
            await self.stream(library_defaults.local_picks(model, function, self.future_config.local_threads, json_check_of(body)))
            return
        if not tiers.is_remote(model):
            raise HTTPError(400, f"unknown model {model!r}")
        refuse_without_remote(self.future_config)
        keep = privacy.keep_local_for_remote(self.future_config, body)
        await self.stream(plain_errors(library_defaults.model_picks(function, self.future_config, keep), self.future_config))


class NextStepsHandler(BaseHandler):
    """Suggestions for the "Worth asking next" list, each tied to a gap."""

    @tornado.web.authenticated
    def post(self):
        body = self.get_json_body()
        try:
            cells = [CellInfo.from_json(cell) for cell in body.get("cells") or []]
            context = Context.from_json(body.get("context"))
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        groups = body.get("groups") or {}
        dismissed = set(body.get("dismissed") or [])
        steps = next_steps(cells, context, groups, dismissed)
        self.finish(json.dumps({"questions": context.for_kernel([step.to_json() for step in steps[:6]])}))


class ClaudeQuestionsHandler(BaseHandler):
    """More questions for a drop, from Claude or from a local model.

    The view asks with the questions that the drop offers already (``offered``),
    so that the model adds what they miss, and the answer orders them all.
    It also sends what agents found in the notebook (``found``).
    """

    @tornado.web.authenticated
    async def post(self):
        selection, context = self.read_selection()
        body = self.get_json_body()
        model = body.get("model") or "remote"
        suggested = templates.generate(selection)
        # A drop onto a cell: the cell's label and code, which the questions are about with the variable.
        try:
            cell = claude_questions.dropped_onto(body.get("cell"))
            offered = claude_questions.offered_from_json(body.get("offered"))
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        formulas = claude_questions.formulas_from_json(body.get("formulas"))
        found = claude_questions.found_from_json(body.get("found"))
        cells_above = body.get("cells_above") if isinstance(body.get("cells_above"), int) else 0
        if local_model_of(body):
            threads = self.future_config.local_threads
            await self.stream(
                claude_questions.generate_local(
                    model, selection, context, suggested, threads, json_check_of(body), cell, offered, cells_above, found=found
                )
            )
            return
        if not tiers.is_remote(model):
            raise HTTPError(400, f"unknown model {model!r}")
        keep = privacy.keep_local_for_remote(self.future_config, body)
        await self.stream(
            claude_questions.generate(selection, context, suggested, self.future_config, keep, cell, offered, formulas, cells_above, found=found)
        )


class ReviewQuestionsHandler(BaseHandler):
    """What a reviewer would ask about the whole notebook, from the model chosen for More questions.

    The Check-up section of the view asks it when the analyst presses Ask
    (design iteration 1.67): ``{"model", "cells", "findings", "context"}``.
    """

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        try:
            request = review.request_from_json(body)
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        if local_model_of(body):
            await self.stream(review.generate_local(request, self.future_config.local_threads, json_check_of(body)))
            return
        if not tiers.is_remote(request.model):
            raise HTTPError(400, f"unknown model {request.model!r}")
        keep = privacy.keep_local_for_remote(self.future_config, body)
        await self.stream(review.generate(request, self.future_config, keep))


class RankQuestionsHandler(BaseHandler):
    """The probability that each offered question is worth asking next, from the model chosen for their order."""

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        try:
            request = ranking.request_from_json(body)
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        request["keep_local"] = privacy.keep_local(self.future_config, body)
        local_model_of(body)
        if tiers.is_remote(request["model"]):
            request["keep_local"] = privacy.keep_local_for_remote(self.future_config, body)
            refuse_without_remote(self.future_config)
        await self.stream(ranking.rank_events(request, self.future_config))


class SortHandler(BaseHandler):
    """The type and the place of a question the analyst types, from a local model or Jev."""

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        model = body.get("model") if isinstance(body, dict) else None
        try:
            request = sorting.request_from_json(body)
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        try:
            # What the call cost, which the view keeps: nothing for a model on this
            # machine, and not known for Jev.
            if local_model_of(body):
                result = {**await local_models.ask_classify(model, request["text"], self.future_config.local_threads), "cost_usd": 0.0}
            elif model == "jev":
                if not self.future_config.typesafe_api_key:
                    raise HTTPError(409, sorting.jev_status(self.future_config)["reason"])
                result = {**await sorting.ask_jev(request, self.future_config), "cost_usd": None}
            else:
                raise HTTPError(400, f"unknown model {model!r}")
        except HTTPError:
            raise
        except Exception as error:  # noqa: BLE001  the view keeps the keywords' type
            raise HTTPError(502, f"{model} could not sort the question: {error}") from error
        self.finish(json.dumps(result))


class SolveHandler(BaseHandler):
    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        keep = privacy.keep_local_for_remote(self.future_config, body)
        if keep and isinstance(body, dict) and body.get("image") is not None:
            raise HTTPError(409, privacy.PICTURE_REFUSED)
        try:
            request = SolveRequest.from_json(body)
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        if keep:
            request = privacy.local_request(request)
        # A file or a table dragged in: its columns come from the server's files.
        request = await asyncio.to_thread(request.with_sources, getattr(self.contents_manager, "root_dir", None))
        await self.stream(solve(request, self.future_config))


class AgentHandler(BaseHandler):
    """An answer by an agent that adds and runs cells: the run's events, one per line.

    Each ``tool`` event asks the view to run a tool; the view posts what came
    out to ``agent/result``, and the run goes on."""

    @tornado.web.authenticated
    async def post(self):
        refuse_without_remote(self.future_config)
        try:
            request = agent.AgentRequest.from_json(self.get_json_body(), self.future_config)
        except InvalidRequest as error:
            raise HTTPError(400, str(error)) from error
        root = getattr(self.contents_manager, "root_dir", None)
        request = dataclasses.replace(request, solve=await asyncio.to_thread(request.solve.with_sources, root))
        driver = connection.agent_driver(self.future_config)
        await self.stream(plain_errors(agent.run_events(request, self.future_config, driver), self.future_config))


class AgentResultHandler(BaseHandler):
    """What a tool of an agent run did in the view: ``{"run", "call", "result"}``."""

    @tornado.web.authenticated
    def post(self):
        body = self.get_json_body()
        if not isinstance(body, dict) or not isinstance(body.get("run"), str) or not isinstance(body.get("call"), str):
            raise HTTPError(400, "the body needs the run, the call and the result")
        if not agent.submit(body["run"], body["call"], body.get("result")):
            raise HTTPError(404, "no tool call of that run waits for a result")
        self.finish(json.dumps({"ok": True}))


class AgentStopHandler(BaseHandler):
    """Stop an agent run: ``{"run"}``. The cells it added stay."""

    @tornado.web.authenticated
    def post(self):
        body = self.get_json_body()
        run = body.get("run") if isinstance(body, dict) else None
        if not isinstance(run, str) or not agent.stop(run):
            raise HTTPError(404, "no such agent run goes on")
        self.finish(json.dumps({"ok": True}))


def connection_state(config: Whybook) -> dict[str, Any]:
    """The connected model and each provider, as the AI models panel shows them: never a key, only whether one is kept."""
    keys = KeyStore()
    chosen = connection.load(config)
    return {
        "connection": chosen.to_json(),
        "readiness": connection.readiness(config),
        # The saved key of the connected model, a server's by its URL: when it was saved, whether it was checked, when it was refused.
        "connected_key": connection.key_state(chosen, keys),
        "providers": [
            {
                "id": provider.id,
                "label": provider.label,
                "local": provider.local,
                "base_url": provider.base_url,
                "signin": provider.signin,
                "needs_key": provider.needs_key,
                "dev_only": provider.dev_only,
                "signed_in": keys.has(provider.id),
                # "typed" for a pasted key, else the sign-in that gave it.
                "key_from": (keys.meta(provider.id) or {}).get("signin"),
                "saved": (keys.meta(provider.id) or {}).get("saved"),
                # False for a key saved without a check; null without a key.
                "checked": (keys.meta(provider.id) or {}).get("checked") is not False if keys.has(provider.id) else None,
                # When the provider last refused the saved key, which the panel then calls wrong.
                "refused": (keys.meta(provider.id) or {}).get("refused"),
                # The SDK of its calls; a server on this machine uses openai's.
                "installed": provider.id in ("none", "claude-code") or model_client.is_installed(provider.id),
            }
            for provider in connection.PROVIDERS.values()
            # The Claude Code login is listed only where the server offers it, for development.
            if provider.id != "none" and (provider.id != "claude-code" or config.claude_code_login)
        ],
        "huggingface_signin": bool(config.huggingface_client_id),
        "models_installed": model_client.is_installed(),
    }


def typed_key(body: Any, provider: str) -> str | None:
    """The key typed with a server's URL, stripped, or None when none is typed.

    A key for a provider that takes none with a URL, or one that no request
    can carry, is refused with 400 before it is kept or sent.
    """
    key = body.get("key") if isinstance(body, dict) else None
    if not isinstance(key, str) or not key.strip():
        return None
    if provider not in connection.TYPED_KEYS:
        raise HTTPError(400, f"{connection.PROVIDERS[provider].label} takes no key here: sign in, or paste its key, first")
    problem = providers.key_problem(key.strip())
    if problem:
        raise HTTPError(400, problem)
    return key.strip()


class ConnectionHandler(BaseHandler):
    """The model connected for cells and answers. POST ``{"provider", "model", "base_url"?, "local"?, "key"?, "check"?}``
    saves a new choice after a check that costs nothing: the provider lists the model, and it takes the key.

    A key typed with a server's URL is saved with the connection once the
    server lists its models with it; a refused key never replaces the key
    saved for that URL (``check_failed``). A server that lists its models
    without the key too asks for none, and the key is not saved. With a typed
    key, ``"check": false`` saves both without a request, the key marked as
    not checked: the analyst's Save anyway, or Save without a check.
    """

    @tornado.web.authenticated
    def get(self):
        self.finish(json.dumps(connection_state(self.future_config)))

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        try:
            chosen = connection.Connection.from_json(body)
        except ValueError as error:
            raise HTTPError(400, str(error)) from error
        if chosen.provider == "claude-code" and not self.future_config.claude_code_login:
            raise HTTPError(400, f"The Claude Code login is for development only, under Anthropic's terms. {connection.SETUP_DEV_ONLY}")
        keys = KeyStore()
        name = connection.key_name(chosen)
        typed = typed_key(body, chosen.provider)
        unchecked = typed is not None and body.get("check") is False
        if chosen.provider not in ("claude-code", "none"):
            if not chosen.model:
                raise HTTPError(400, "choose a model")
            provider = connection.PROVIDERS[chosen.provider]
            key = typed or keys.get(name)
            if provider.needs_key and not key:
                raise HTTPError(409, f"{provider.label}: {'sign in' if provider.signin else 'paste its API key'} first")
            if not unchecked:
                try:
                    listed = await providers.models(
                        chosen.provider, key=key, base_url=chosen.url, zdr=self.future_config.zdr, typed=typed is not None
                    )
                    if chosen.provider == "openrouter":
                        if not key:
                            raise providers.ProviderError("OpenRouter: sign in first")
                        await providers.check_openrouter_key(key)
                except providers.ProviderError as error:
                    if isinstance(error, providers.KeyRefused) and typed is None and key:
                        keys.refuse(name, key)
                    self.check_failed(error, keys.meta(name))
                    return
                if listed and chosen.model not in {model["id"] for model in listed}:
                    raise HTTPError(409, f"{provider.label} does not list {chosen.model!r}: choose one of its models")
                if typed is None:
                    if key and (providers.lists_with_key(chosen.provider) or chosen.provider == "openrouter"):
                        keys.confirm(name, key)
                elif await providers.lists_without_key(chosen.provider, chosen.url):
                    # The server asks for no key, so it takes any: the typed key is not saved.
                    typed = None
        if typed is not None:
            keys.set(name, typed, signin="typed", **({"checked": False} if unchecked else {}))
        connection.save(chosen)
        self.finish(json.dumps(connection_state(self.future_config)))


class ConnectionModelsHandler(BaseHandler):
    """The models of one provider: POST ``{"provider", "base_url"?, "key"?}``.

    A POST, which Jupyter checks for its XSRF token: a GET could come from a
    page of any site. A key typed for a server goes only to the URL it was
    typed for (``connection.key_name``). A key typed with the URL is checked
    here and saved by nothing: the answer says that the server took it
    ("key_check": "accepted"), or that it lists its models without a key too
    ("not needed"), with when the key saved for that URL was saved. A listing
    with the saved key checks that key.
    """

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        provider = body.get("provider") if isinstance(body, dict) else None
        if provider not in connection.PROVIDERS or provider in ("claude-code", "none"):
            raise HTTPError(400, f"no model list for {provider!r}")
        try:
            chosen = connection.Connection.from_json({"provider": provider, "base_url": body.get("base_url") or None})
        except ValueError as error:
            raise HTTPError(400, str(error)) from error
        keys = KeyStore()
        name = connection.key_name(chosen)
        typed = typed_key(body, provider)
        key = typed or keys.get(name)
        try:
            # With zero data retention, the models that have a provider that keeps no data.
            listed = await providers.models(provider, key=key, base_url=chosen.url, zdr=self.future_config.zdr, typed=typed is not None)
        except providers.ProviderError as error:
            if isinstance(error, providers.KeyRefused) and typed is None and key:
                keys.refuse(name, key)
            self.check_failed(error, keys.meta(name))
            return
        if typed is None:
            if key and providers.lists_with_key(provider):
                keys.confirm(name, key)
            self.finish(json.dumps({"models": listed}))
            return
        needed = not await providers.lists_without_key(provider, chosen.url)
        self.finish(json.dumps({"models": listed, "key_check": "accepted" if needed else "not needed", "saved": (keys.meta(name) or {}).get("saved")}))


class LocalServersHandler(BaseHandler):
    """The model servers that answer on this machine: Ollama, LM Studio, llama.cpp and vLLM on their default ports."""

    @tornado.web.authenticated
    async def get(self):
        self.finish(json.dumps({"servers": await providers.discover()}))


class OpenRouterSignInHandler(BaseHandler):
    """Start a sign-in with OpenRouter: ``{"callback_base"}``, this route's callback as the browser reaches it, or null."""

    @tornado.web.authenticated
    def post(self):
        body = self.get_json_body()
        callback = body.get("callback_base") if isinstance(body, dict) else None
        self.finish(json.dumps(signin.openrouter_start(callback if isinstance(callback, str) else None)))


class OpenRouterCodeHandler(BaseHandler):
    """The code that OpenRouter showed, pasted into the panel: ``{"state", "code"}``."""

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        if not isinstance(body, dict) or not isinstance(body.get("state"), str) or not isinstance(body.get("code"), str):
            raise HTTPError(400, "the body needs the state and the code")
        try:
            await signin.openrouter_exchange(body["state"], body["code"])
        except signin.SignInError as error:
            raise HTTPError(409, str(error)) from error
        self.finish(json.dumps(connection_state(self.future_config)))


CALLBACK_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Whybook: OpenRouter</title></head>
<body style="font: 14px/1.5 system-ui, sans-serif; margin: 3em auto; max-width: 36em; padding: 0 1em">
<p>{message}</p>
<p>Close this tab and go back to Whybook.</p>
</body></html>"""


class OpenRouterCallbackHandler(JupyterHandler):
    """Where OpenRouter sends the browser back, with ``?code=``: the server exchanges the code for the key."""

    def initialize(self, config: Whybook):
        self.future_config = config

    @tornado.web.authenticated
    async def get(self, state: str):
        code = self.get_query_argument("code", "")
        try:
            await signin.openrouter_exchange(state, code)
            message = "Signed in to OpenRouter. The AI models panel now lists its models."
        except signin.SignInError as error:
            self.set_status(409)
            message = f"The sign-in to OpenRouter failed: {error}"
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.finish(CALLBACK_PAGE.format(message=html.escape(message)))


class HuggingFaceSignInHandler(BaseHandler):
    """Start a sign-in with Hugging Face: the device code that the analyst approves on huggingface.co."""

    @tornado.web.authenticated
    async def post(self):
        try:
            started = await signin.huggingface_start(self.future_config.huggingface_client_id)
        except signin.SignInError as error:
            raise HTTPError(409, str(error)) from error
        self.finish(json.dumps(started))


class HuggingFacePollHandler(BaseHandler):
    """Ask Hugging Face once whether the analyst approved the code: ``{"flow"}``."""

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        if not isinstance(body, dict) or not isinstance(body.get("flow"), str):
            raise HTTPError(400, "the body needs the flow")
        try:
            polled = await signin.huggingface_poll(body["flow"], self.future_config.huggingface_client_id)
        except signin.SignInError as error:
            raise HTTPError(409, str(error)) from error
        self.finish(json.dumps(polled))


class KeyHandler(BaseHandler):
    """Keep a key pasted into the panel, after a check that costs nothing: ``{"provider", "key", "check"?}``.

    Anthropic, OpenAI, Google and Mistral AI list their models with the key;
    Hugging Face says whose token it is. A key that the provider refuses, or
    cannot check, is not kept, and the saved key stays in use (``check_failed``).
    ``"check": false`` keeps the key without a request, marked as not
    checked: the analyst's Save anyway, or Save without a check.
    """

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body()
        provider = body.get("provider") if isinstance(body, dict) else None
        key = body.get("key") if isinstance(body, dict) else None
        if provider not in connection.PASTED_KEYS:
            raise HTTPError(400, f"{provider!r} takes no pasted key")
        if not isinstance(key, str) or not key.strip() or len(key) > 500:
            raise HTTPError(400, "paste the key")
        problem = providers.key_problem(key.strip())
        if problem:
            raise HTTPError(400, problem)
        keys = KeyStore()
        if body.get("check") is False:
            keys.set(provider, key.strip(), signin="typed", checked=False)
        else:
            try:
                await providers.check_key(provider, key.strip())
            except providers.ProviderError as error:
                self.check_failed(error, keys.meta(provider))
                return
            keys.set(provider, key.strip(), signin="typed")
        self.finish(json.dumps(connection_state(self.future_config)))


class SignOutHandler(BaseHandler):
    """Forget the key of a provider: ``{"provider"}``. The provider still accepts it until it is revoked there."""

    @tornado.web.authenticated
    def post(self):
        body = self.get_json_body()
        provider = body.get("provider") if isinstance(body, dict) else None
        if provider not in connection.PROVIDERS:
            raise HTTPError(400, f"unknown provider {provider!r}")
        KeyStore().delete(provider)
        self.finish(json.dumps(connection_state(self.future_config)))


def setup_route_handlers(web_app, config: Whybook):
    base_url = web_app.settings["base_url"]
    routes = [
        (("status",), StatusHandler),
        (("questions", "claude"), ClaudeQuestionsHandler),
        (("questions", "review"), ReviewQuestionsHandler),
        (("questions", "sort"), SortHandler),
        (("questions", "rank"), RankQuestionsHandler),
        (("drop",), DropHandler),
        (("cell-questions",), CellQuestionsHandler),
        (("decision",), DecisionHandler),
        (("decision", "values"), DecisionValuesHandler),
        (("defaults",), LibraryDefaultsHandler),
        (("defaults", "ask"), LibraryDefaultsAskHandler),
        (("next",), NextStepsHandler),
        (("solve",), SolveHandler),
        (("agent",), AgentHandler),
        (("agent", "result"), AgentResultHandler),
        (("agent", "stop"), AgentStopHandler),
        (("databases",), DatabasesHandler),
        (("databases", "tables"), DatabaseTablesHandler),
        (("dependencies",), DependenciesHandler),
        (("dependencies", "claude"), ClaudeDependenciesHandler),
        (("tables", "describe"), TableNotesHandler),
        (("frames", "describe"), FrameNotesHandler),
        (("cells", "title"), CellTitlesHandler),
        (("models", "download"), ModelDownloadHandler),
        (("speech", "transcribe"), SpeechTranscribeHandler),
        (("speech", "download"), SpeechDownloadHandler),
        (("connection",), ConnectionHandler),
        (("connection", "models"), ConnectionModelsHandler),
        (("connection", "local"), LocalServersHandler),
        (("auth", "openrouter"), OpenRouterSignInHandler),
        (("auth", "openrouter", "code"), OpenRouterCodeHandler),
        (("auth", "openrouter", "callback", r"([A-Za-z0-9_\-]+)"), OpenRouterCallbackHandler),
        (("auth", "huggingface"), HuggingFaceSignInHandler),
        (("auth", "huggingface", "poll"), HuggingFacePollHandler),
        (("auth", "key"), KeyHandler),
        (("auth", "signout"), SignOutHandler),
    ]
    handlers = [
        (url_path_join(base_url, "whybook", *parts), handler, {"config": config})
        for parts, handler in routes
    ]
    web_app.add_handlers(".*$", handlers)
