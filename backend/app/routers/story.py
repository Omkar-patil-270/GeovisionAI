# backend/app/routers/story.py
import os
import httpx
from groq import Groq
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from . import cache_utils


def load_env():
    try:
        env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if line and "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()
    except FileNotFoundError:
        pass


load_env()

router = APIRouter()
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

WIKI_SUMMARY_CACHE_TTL = 60 * 60 * 24
IMAGES_CACHE_TTL = 60 * 60 * 24
STORY_SECTION_CACHE_TTL = 60 * 60 * 6

# The six sections the interactive story UI steps through, in order.
SECTION_ORDER = ["overview", "history", "geography", "culture", "economy", "facts"]

SECTION_PROMPTS = {
    "history": "Write 2-3 sentences on the HISTORY of {location}: origins, notable historical events, how it developed over time.",
    "geography": "Write 2-3 sentences on the GEOGRAPHY of {location}: terrain, climate, rivers/mountains/coastline, notable natural features.",
    "culture": "Write 2-3 sentences on the CULTURE of {location}: languages, festivals, traditions, cuisine, notable cultural sites.",
    "economy": "Write 2-3 sentences on the ECONOMY of {location}: main industries, livelihoods, economic role in the wider region.",
    "facts": "Write 2-3 sentences of genuinely INTERESTING FACTS about {location} — surprising, specific, memorable details.",
}


async def get_wikipedia_summary(location_name: str):
    key = cache_utils.make_key("wiki_summary", location_name.strip().lower())

    async def _fetch():
        short_name = location_name.split(",")[0].strip()
        try:
            async with httpx.AsyncClient(timeout=8) as c:
                res = await c.get(
                    f"https://en.wikipedia.org/api/rest_v1/page/summary/{short_name}",
                    headers={"User-Agent": "GeoVisionAI/1.0"},
                )
                if res.status_code == 200:
                    data = res.json()
                    if data.get("type") != "disambiguation":
                        return {
                            "extract": data.get("extract"),
                            "title": data.get("title"),
                            "wikibase_item": data.get("wikibase_item"),
                        }
        except Exception:
            pass
        return None

    return await cache_utils.get_or_set(key, WIKI_SUMMARY_CACHE_TTL, _fetch)


# ---------------------------------------------------------------------------
# Images — Wikimedia Commons/Wikipedia, with automatic fallback across
# several candidate article titles (exact place + admin level, then
# progressively broader names) so a single miss never means "no image".
# Each image keeps its source page + best-effort credit/license info.
# ---------------------------------------------------------------------------
async def _fetch_images_for_title(c: httpx.AsyncClient, title: str, limit: int):
    results = []
    try:
        res = await c.get(
            "https://en.wikipedia.org/w/api.php",
            params={
                "action": "query", "format": "json", "prop": "pageimages|images",
                "titles": title, "pithumbsize": 900, "imlimit": 30, "redirects": 1,
            },
            headers={"User-Agent": "GeoVisionAI/1.0"},
        )
        data = res.json()
        pages = data.get("query", {}).get("pages", {})
        page = next(iter(pages.values()), {})
        if "missing" in page:
            return []

        thumb = page.get("thumbnail", {}).get("source")
        page_title = page.get("title", title)
        page_url = f"https://en.wikipedia.org/wiki/{page_title.replace(' ', '_')}"
        if thumb:
            results.append({"url": thumb, "credit": "Wikipedia", "source_title": page_title, "source_url": page_url})

        image_titles = [
            img["title"] for img in page.get("images", [])
            if img["title"].lower().endswith((".jpg", ".jpeg", ".png"))
            and not any(bad in img["title"].lower() for bad in ("icon", "logo", "flag", "map", "commons-logo", "edit-icon"))
        ][: limit * 2]

        if image_titles:
            res2 = await c.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "query", "format": "json", "prop": "imageinfo",
                    "titles": "|".join(image_titles), "iiprop": "url|extmetadata", "iiurlwidth": 900,
                },
                headers={"User-Agent": "GeoVisionAI/1.0"},
            )
            data2 = res2.json()
            for p in data2.get("query", {}).get("pages", {}).values():
                info = p.get("imageinfo", [{}])[0]
                url = info.get("thumburl") or info.get("url")
                if not url:
                    continue
                meta = info.get("extmetadata", {}) or {}
                artist = _strip_html(meta.get("Artist", {}).get("value", "")) if meta.get("Artist") else None
                license_name = meta.get("LicenseShortName", {}).get("value") if meta.get("LicenseShortName") else None
                credit_parts = [p_ for p_ in [artist, license_name] if p_]
                results.append({
                    "url": url,
                    "credit": " · ".join(credit_parts) if credit_parts else "Wikimedia Commons",
                    "source_title": p.get("title", title).replace("File:", ""),
                    "source_url": info.get("descriptionurl") or page_url,
                })
    except Exception:
        pass
    return results


def _strip_html(text: str) -> str:
    import re
    return re.sub(r"<[^>]+>", "", text or "").strip()


def _build_candidate_titles(location_name: str, level_label: Optional[str]):
    """
    Search using the EXACT selected location name + administrative level
    first (e.g. "Kolhapur district"), then fall back to progressively
    broader/plainer names so a narrow miss still finds something real
    rather than showing nothing.
    """
    short_name = location_name.split(",")[0].strip()
    candidates = []
    if level_label and level_label not in ("Settlement", "Region", "Local area"):
        # e.g. "Kolhapur District", "Gadhinglaj Taluka"
        suffix = level_label.split("/")[0]  # "Taluka/Tehsil" -> "Taluka"
        candidates.append(f"{short_name} {suffix}")
    candidates.append(short_name)
    # Broader fallback: the full comma-separated label often resolves to a
    # disambiguated / more specific Wikipedia title (e.g. "X, State").
    if "," in location_name:
        candidates.append(location_name.split(",")[0].strip() + ", " + location_name.split(",")[1].strip())
    # De-dup while preserving order.
    seen = set()
    out = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


async def get_location_images(location_name: str, level_label: str = None, limit: int = 8):
    key = cache_utils.make_key("images", location_name.strip().lower(), (level_label or "").lower(), limit)

    async def _fetch():
        candidates = _build_candidate_titles(location_name, level_label)
        collected = []
        seen_urls = set()
        async with httpx.AsyncClient(timeout=8) as c:
            for title in candidates:
                if len(collected) >= limit:
                    break
                for img in await _fetch_images_for_title(c, title, limit):
                    if img["url"] not in seen_urls:
                        seen_urls.add(img["url"])
                        collected.append(img)
                    if len(collected) >= limit:
                        break
        return collected[:limit]

    return await cache_utils.get_or_set(key, IMAGES_CACHE_TTL, _fetch)


# ---------------------------------------------------------------------------
# Storytelling — progressive, section-by-section
# ---------------------------------------------------------------------------
class StoryRequest(BaseModel):
    location_name: str
    predictions: dict
    level_label: Optional[str] = None


class SectionRequest(BaseModel):
    location_name: str
    predictions: dict
    section: str  # one of SECTION_ORDER
    level_label: Optional[str] = None


def _wiki_context(wiki):
    return (
        f"Verified encyclopedic background: {wiki['extract']}" if wiki
        else "No verified encyclopedic summary was found for this exact place — rely only on the real "
             "data given and be conservative about historical/cultural claims."
    )


@router.post("/section")
async def generate_story_section(req: SectionRequest):
    """
    Generates ONE story section at a time so the frontend can render cards
    progressively (Overview first, then History/Geography/Culture/Economy/
    Facts as the user steps through them) instead of blocking on one huge
    response. Each section is its own small, fast Groq call.
    """
    if req.section not in SECTION_ORDER:
        raise HTTPException(status_code=400, detail=f"Unknown section '{req.section}'. Expected one of {SECTION_ORDER}.")

    key = cache_utils.make_key("story_section", req.location_name.strip().lower(), req.section)

    async def _generate():
        wiki = await get_wikipedia_summary(req.location_name)
        wiki_context = _wiki_context(wiki)

        if req.section == "overview":
            prompt = (
                f"Write a 3-4 sentence opening briefing for a geospatial intelligence report on "
                f"{req.location_name} ({req.level_label or 'region'}). Real data: {req.predictions}. "
                f"{wiki_context} Open with a striking, specific detail, weave in real numbers naturally, "
                f"and note one genuinely interesting or concerning trend. Vivid but precise. No headings, "
                f"no bullet points, no 'in conclusion'. Every claim must come from the data/context given."
            )
        else:
            template = SECTION_PROMPTS[req.section]
            prompt = (
                f"Location: {req.location_name} ({req.level_label or 'region'}). {wiki_context} "
                f"Real data: {req.predictions}. " + template.format(location=req.location_name) +
                " Use ONLY the context and data given — if it doesn't cover something, say so briefly "
                "rather than inventing it. No headings, no bullet points."
            )

        try:
            res = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.7,
            )
            text = res.choices[0].message.content.strip()
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e))

        return {"section": req.section, "text": text, "wikipedia_source": wiki["title"] if wiki else None}

    cached = cache_utils.get(key)
    if cached is not None:
        return cached
    result = await _generate()
    cache_utils.set(key, result, STORY_SECTION_CACHE_TTL)
    return result


@router.get("/images")
async def story_images(location_name: str, level_label: str = None, limit: int = 8):
    """Standalone image endpoint — lets the frontend load photos independently
    of (and in parallel with) the story text, with caching and credits."""
    images = await get_location_images(location_name, level_label=level_label, limit=limit)
    return {"location_name": location_name, "images": images}


@router.post("/generate")
async def generate_story(req: StoryRequest):
    """
    Backward-compatible one-shot endpoint: generates every section (via the
    same cached per-section logic as /section) plus images in one response.
    Prefer POST /section + GET /images for progressive loading in the UI —
    this endpoint mainly exists for the PDF report / other non-interactive
    consumers that want the whole story at once.
    """
    wiki = await get_wikipedia_summary(req.location_name)
    images = await get_location_images(req.location_name, level_label=req.level_label)

    sections = {}
    for name in SECTION_ORDER:
        if name == "overview":
            continue
        section_req = SectionRequest(
            location_name=req.location_name, predictions=req.predictions,
            section=name, level_label=req.level_label,
        )
        result = await generate_story_section(section_req)
        sections[name] = result["text"]

    overview_req = SectionRequest(
        location_name=req.location_name, predictions=req.predictions,
        section="overview", level_label=req.level_label,
    )
    overview_result = await generate_story_section(overview_req)

    return {
        "location_name": req.location_name,
        "story": overview_result["text"],
        "sections": sections,
        "images": [img["url"] for img in images],
        "image_credits": images,
        "wikipedia_source": wiki["title"] if wiki else None,
    }
