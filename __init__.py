"""Loulan-prompt — a ComfyUI custom node for writing and batch-queuing prompts.

This package provides one node (``Loulan-prompt``): a batch prompt writer with
an editable, paginated prompt library with selection modes, a global
trigger prefix, txt/csv/json folder import, folder-based presets and queue
splitting. The heavy lifting is done by the frontend extension in
``web/prompt_batch_writer.js``; the backend node only receives the single
combined prompt for the current queue item and forwards it as a ``STRING``
output (typically wired into CLIPTextEncode).

It also registers a few HTTP routes used by the frontend to manage local
presets (list / save / open the presets folder). Presets are stored under
ComfyUI's user directory so they survive reinstalls.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from aiohttp import web
from comfy_api.latest import ComfyExtension, io
from comfy.cli_args import args
from folder_paths import get_user_directory
from server import PromptServer

WEB_DIRECTORY = "./web"
__all__ = ["WEB_DIRECTORY"]

MAX_PROMPT_LEN = 100000
MAX_NAME_LEN = 100


class LoulanPrompt(io.ComfyNode):
    """Forward the single prompt selected for this queue item."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="Loulan-prompt",
            display_name="Loulan-prompt",
            category="prompt",
            inputs=[
                io.String.Input(
                    "prompt",
                    multiline=True,
                    default="",
                    tooltip="Current prompt. Filled automatically by the batch writer frontend per queue item.",
                ),
            ],
            outputs=[
                io.String.Output("prompt"),
            ],
        )

    @classmethod
    def execute(cls, prompt) -> io.NodeOutput:
        return io.NodeOutput(prompt)


class LoulanPromptExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [LoulanPrompt]


async def comfy_entrypoint() -> LoulanPromptExtension:
    """Called by ComfyUI to load this extension and register its nodes."""
    return LoulanPromptExtension()


# ---------------------------------------------------------------------------
# Local presets (folder-based) routes
# ---------------------------------------------------------------------------

def _presets_dir(request) -> Path:
    """Keep single-user presets in their original directory."""
    if args.multi_user:
        manager = PromptServer.instance.user_manager
        d = Path(manager.get_request_user_filepath(request, "loulan-prompt/presets"))
    else:
        d = Path(get_user_directory()) / "loulan-prompt" / "presets"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _open_folder(path: Path) -> None:
    """Open a folder in the OS file explorer (cross-platform)."""
    if sys.platform == "win32":
        os.startfile(str(path))
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def _validate_preset(body: dict):
    """Validate a save-preset request body. Returns (error, name, preset)."""
    if not isinstance(body, dict):
        return "Expected an object", None, None
    name = body.get("name")
    name = name.strip() if isinstance(name, str) else ""
    preset = body.get("preset")
    if not name or len(name) > MAX_NAME_LEN:
        return "Preset name is empty or too long", None, None
    reserved = re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", name.split(".")[0], re.I)
    if reserved or name.endswith(".") or any(ord(c) < 32 or c in '<>:"/\\|?*' for c in name):
        return "Invalid preset filename", None, None
    if not isinstance(preset, dict):
        return "Preset must be an object", None, None
    rows = preset.get("rows")
    if rows is not None:
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            return "Invalid preset rows", None, None
        prompts = [row.get("text") for row in rows]
    else:
        prompts = preset.get("prompts")
    if not isinstance(prompts, list) or not prompts:
        return "Preset has no prompts", None, None
    if not any(isinstance(p, str) and p.strip() for p in prompts):
        return "Preset has no valid (non-empty) prompts", None, None
    if any(not isinstance(p, str) or len(p) > MAX_PROMPT_LEN for p in prompts):
        return "Invalid or too long prompt", None, None
    return None, name, {**preset, "name": name}


def _create_preset(directory, name, preset):
    """Publish a complete JSON file, failing if the name is already taken."""
    dest = directory / (name + ".json")
    fd, temporary = tempfile.mkstemp(dir=directory, suffix=".tmp")
    temp = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(preset, handle, ensure_ascii=False)
        if os.name == "nt":
            temp.rename(dest)  # On Windows rename fails if dest exists.
        else:
            os.link(temp, dest)
    finally:
        temp.unlink(missing_ok=True)


if hasattr(PromptServer, "instance") and PromptServer.instance is not None:
    _routes = PromptServer.instance.routes

    @_routes.post("/loulan/open_presets")
    async def open_presets(request):
        """Open the local presets folder in the OS file explorer."""
        try:
            _open_folder(_presets_dir(request))
        except Exception as e:
            return web.json_response({"ok": False, "error": f"Failed to open the presets folder: {e}"})
        return web.json_response({"ok": True})

    @_routes.get("/loulan/presets")
    async def list_presets(request):
        """Return all preset files in the presets folder as a JSON list."""
        try:
            d = _presets_dir(request)
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})
        presets = []
        for f in sorted(d.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            if isinstance(data, dict):
                presets.append(data)
            elif isinstance(data, list):
                presets.append({"name": f.stem, "trigger": "", "prompts": data})
        return web.json_response(presets)

    @_routes.post("/loulan/save_preset")
    async def save_preset(request):
        """Save a preset JSON file into the presets folder (atomic write)."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)

        error, name, preset = _validate_preset(body)
        if error:
            return web.json_response({"ok": False, "error": error}, status=400)

        try:
            _create_preset(_presets_dir(request), name, preset)
        except FileExistsError:
            return web.json_response({"ok": False, "error": "Preset name already exists"}, status=409)
        except Exception as e:
            return web.json_response({"ok": False, "error": f"Failed to save preset: {e}"}, status=500)
        return web.json_response({"ok": True, "name": name})
