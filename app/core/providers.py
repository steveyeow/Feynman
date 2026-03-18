from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx

from . import config

log = logging.getLogger(__name__)


class ProviderError(RuntimeError):
    pass


@dataclass
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


@dataclass
class ChatResult:
    content: str
    raw: dict[str, Any]
    grounding: list[dict[str, str]] | None = None  # [{title, url, snippet}]
    usage: TokenUsage | None = None


class BaseProvider:
    name: str

    def has_key(self) -> bool:
        raise NotImplementedError

    def supports_embeddings(self) -> bool:
        return False

    def embed_texts(self, texts: list[str], task_type: str | None = None) -> list[list[float]]:
        raise NotImplementedError

    def chat(self, system: str, user: str, history: list[dict[str, str]] | None = None, use_grounding: bool = False) -> ChatResult:
        raise NotImplementedError


class OpenAICompatibleProvider(BaseProvider):
    def __init__(self, name: str, api_key: str, base_url: str, chat_model: str, embed_model: str | None = None):
        self.name = name
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.chat_model = chat_model
        self.embed_model = embed_model

    def has_key(self) -> bool:
        return bool(self.api_key)

    def supports_embeddings(self) -> bool:
        return bool(self.embed_model)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        with httpx.Client(timeout=60) as client:
            resp = client.post(url, headers=self._headers(), json=payload)
        if resp.status_code >= 400:
            raise ProviderError(f"{self.name} error {resp.status_code}: {resp.text}")
        return resp.json()

    def embed_texts(self, texts: list[str], task_type: str | None = None) -> list[list[float]]:
        if not self.embed_model:
            raise ProviderError(f"{self.name} does not support embeddings (missing model)")
        payload = {
            "model": self.embed_model,
            "input": texts,
        }
        data = self._post("/embeddings", payload)
        return [item["embedding"] for item in data.get("data", [])]

    def chat(self, system: str, user: str, history: list[dict[str, str]] | None = None, use_grounding: bool = False) -> ChatResult:
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": user})
        payload = {
            "model": self.chat_model,
            "messages": messages,
            "temperature": 0.2,
        }
        data = self._post("/chat/completions", payload)
        content = data["choices"][0]["message"]["content"]
        usage = None
        if "usage" in data:
            u = data["usage"]
            usage = TokenUsage(
                input_tokens=u.get("prompt_tokens", 0),
                output_tokens=u.get("completion_tokens", 0),
                total_tokens=u.get("total_tokens", 0),
            )
        return ChatResult(content=content, raw=data, usage=usage)


class GeminiProvider(BaseProvider):
    name = "gemini"

    def __init__(self, api_key: str, base_url: str, chat_model: str, embed_model: str):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.chat_model = chat_model
        self.embed_model = embed_model

    def has_key(self) -> bool:
        return bool(self.api_key)

    def supports_embeddings(self) -> bool:
        return bool(self.embed_model)

    def _headers(self) -> dict[str, str]:
        return {
            "x-goog-api-key": self.api_key,
            "Content-Type": "application/json",
        }

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        with httpx.Client(timeout=60) as client:
            resp = client.post(url, headers=self._headers(), json=payload)
        if resp.status_code >= 400:
            raise ProviderError(f"Gemini error {resp.status_code}: {resp.text}")
        return resp.json()

    def embed_texts(self, texts: list[str], task_type: str | None = None) -> list[list[float]]:
        task_type = task_type or "RETRIEVAL_DOCUMENT"
        path = f"/models/{self.embed_model}:batchEmbedContents"
        _BATCH_LIMIT = 100
        _RPM_LIMIT = 95
        _MAX_RETRIES = 5
        all_embeddings: list[list[float]] = []
        total_batches = (len(texts) + _BATCH_LIMIT - 1) // _BATCH_LIMIT
        sent_this_window = 0
        window_start = time.monotonic()
        for batch_idx, i in enumerate(range(0, len(texts), _BATCH_LIMIT)):
            batch = texts[i : i + _BATCH_LIMIT]

            if sent_this_window + len(batch) > _RPM_LIMIT:
                elapsed = time.monotonic() - window_start
                if elapsed < 60:
                    wait = 61 - elapsed
                    log.info("Embedding rate-limit pause: %.0fs before batch %d/%d", wait, batch_idx + 1, total_batches)
                    time.sleep(wait)
                sent_this_window = 0
                window_start = time.monotonic()

            requests = [
                {
                    "model": f"models/{self.embed_model}",
                    "content": {"parts": [{"text": text}]},
                    "taskType": task_type,
                }
                for text in batch
            ]
            for attempt in range(_MAX_RETRIES + 1):
                try:
                    data = self._post(path, {"requests": requests})
                    break
                except ProviderError as exc:
                    if "429" in str(exc) and attempt < _MAX_RETRIES:
                        wait = min(30, 10 * (attempt + 1))
                        log.warning("Gemini 429 on batch %d/%d, retry in %ds...", batch_idx + 1, total_batches, wait)
                        time.sleep(wait)
                        sent_this_window = 0
                        window_start = time.monotonic()
                    else:
                        raise
            sent_this_window += len(batch)
            for item in data.get("embeddings", []):
                all_embeddings.append(item.get("values", []))
        return all_embeddings

    def chat(self, system: str, user: str, history: list[dict[str, str]] | None = None, use_grounding: bool = False) -> ChatResult:
        parts: list[dict[str, str]] = []
        prompt = system.strip()
        if prompt:
            prompt = f"{prompt}\n\n"
        prompt += user
        parts.append({"text": prompt})
        payload: dict[str, Any] = {
            "contents": [
                {
                    "role": "user",
                    "parts": parts,
                }
            ]
        }
        if use_grounding:
            payload["tools"] = [{"google_search": {}}]
        path = f"/models/{self.chat_model}:generateContent"
        data = self._post(path, payload)
        candidates = data.get("candidates", [])
        if not candidates:
            raise ProviderError("Gemini returned no candidates")
        content_parts = candidates[0].get("content", {}).get("parts", [])
        text = "".join(part.get("text", "") for part in content_parts)

        # Parse grounding metadata if present
        grounding = None
        grounding_meta = candidates[0].get("groundingMetadata")
        if grounding_meta:
            grounding = []
            for chunk in grounding_meta.get("groundingChunks", []):
                web = chunk.get("web", {})
                if web.get("uri"):
                    grounding.append({
                        "title": web.get("title", ""),
                        "url": web["uri"],
                    })

        usage = None
        usage_meta = data.get("usageMetadata")
        if usage_meta:
            usage = TokenUsage(
                input_tokens=usage_meta.get("promptTokenCount", 0),
                output_tokens=usage_meta.get("candidatesTokenCount", 0),
                total_tokens=usage_meta.get("totalTokenCount", 0),
            )

        return ChatResult(content=text, raw=data, grounding=grounding, usage=usage)


def _openai_provider() -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        name="openai",
        api_key=config.OPENAI_API_KEY,
        base_url=config.OPENAI_BASE_URL,
        chat_model=config.OPENAI_CHAT_MODEL,
        embed_model=config.OPENAI_EMBED_MODEL,
    )


def _kimi_provider() -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        name="kimi",
        api_key=config.KIMI_API_KEY,
        base_url=config.KIMI_BASE_URL,
        chat_model=config.KIMI_CHAT_MODEL,
        embed_model=config.KIMI_EMBED_MODEL or None,
    )


def _deepseek_provider() -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        name="deepseek",
        api_key=config.DEEPSEEK_API_KEY,
        base_url=config.DEEPSEEK_BASE_URL,
        chat_model=config.DEEPSEEK_CHAT_MODEL,
    )


def _novita_provider() -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        name="novita",
        api_key=config.NOVITA_API_KEY,
        base_url=config.NOVITA_BASE_URL,
        chat_model=config.NOVITA_CHAT_MODEL,
        embed_model=config.NOVITA_EMBED_MODEL or None,
    )


class AnthropicProvider(BaseProvider):
    name = "anthropic"

    def __init__(self, api_key: str, base_url: str, chat_model: str):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.chat_model = chat_model

    def has_key(self) -> bool:
        return bool(self.api_key)

    def chat(self, system: str, user: str, history: list[dict[str, str]] | None = None, use_grounding: bool = False) -> ChatResult:
        messages: list[dict[str, Any]] = []
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": user})
        payload: dict[str, Any] = {
            "model": self.chat_model,
            "max_tokens": 4096,
            "messages": messages,
        }
        if system:
            payload["system"] = system
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        with httpx.Client(timeout=60) as client:
            resp = client.post(f"{self.base_url}/v1/messages", headers=headers, json=payload)
        if resp.status_code >= 400:
            raise ProviderError(f"anthropic error {resp.status_code}: {resp.text}")
        data = resp.json()
        content = "".join(b.get("text", "") for b in data.get("content", []))
        usage = None
        if "usage" in data:
            u = data["usage"]
            usage = TokenUsage(
                input_tokens=u.get("input_tokens", 0),
                output_tokens=u.get("output_tokens", 0),
                total_tokens=u.get("input_tokens", 0) + u.get("output_tokens", 0),
            )
        return ChatResult(content=content, raw=data, usage=usage)


def _anthropic_provider() -> AnthropicProvider:
    return AnthropicProvider(
        api_key=config.ANTHROPIC_API_KEY,
        base_url=config.ANTHROPIC_BASE_URL,
        chat_model=config.ANTHROPIC_CHAT_MODEL,
    )


def _gemini_provider() -> GeminiProvider:
    return GeminiProvider(
        api_key=config.GEMINI_API_KEY,
        base_url=config.GEMINI_BASE_URL,
        chat_model=config.GEMINI_CHAT_MODEL,
        embed_model=config.GEMINI_EMBED_MODEL,
    )


def get_provider(name: str) -> BaseProvider:
    name = name.lower()
    if name == "openai":
        return _openai_provider()
    if name == "gemini":
        return _gemini_provider()
    if name == "kimi":
        return _kimi_provider()
    if name == "deepseek":
        return _deepseek_provider()
    if name == "novita":
        return _novita_provider()
    if name == "anthropic":
        return _anthropic_provider()
    raise ProviderError(f"Unknown provider: {name}")


def pick_provider(kind: str) -> BaseProvider:
    kind = kind.lower()
    target = config.CHAT_PROVIDER if kind == "chat" else config.EMBED_PROVIDER
    if target != "auto":
        provider = get_provider(target)
        if not provider.has_key():
            raise ProviderError(f"{target} key missing")
        if kind == "embed" and not provider.supports_embeddings():
            raise ProviderError(f"{target} does not support embeddings")
        return provider

    for name in config.PROVIDER_ORDER:
        provider = get_provider(name)
        if not provider.has_key():
            continue
        if kind == "embed" and not provider.supports_embeddings():
            continue
        return provider

    raise ProviderError(f"No available provider for {kind}")


def chat_with_fallback(
    system: str,
    user: str,
    history: list[dict[str, str]] | None = None,
    use_grounding: bool = False,
) -> tuple[ChatResult, BaseProvider]:
    """Try each provider in order until one succeeds. Returns (result, provider)."""
    errors: list[str] = []
    for name in config.PROVIDER_ORDER:
        provider = get_provider(name)
        if not provider.has_key():
            continue
        try:
            result = provider.chat(
                system=system,
                user=user,
                history=history,
                use_grounding=use_grounding and isinstance(provider, GeminiProvider),
            )
            return result, provider
        except Exception as exc:
            errors.append(f"{name}: {exc}")
            continue
    raise ProviderError("All providers failed: " + "; ".join(errors))
