import os
import asyncio
from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel
from groq import Groq
from .predictions import get_predictions


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
_groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))


class CompareLocation(BaseModel):
    name: str
    lat: float
    lon: float
    level: Optional[str] = None
    country_code: Optional[str] = None
    boundary_query: Optional[str] = None


class CompareRequest(BaseModel):
    location_a: CompareLocation
    location_b: CompareLocation


def _diff_metric(a_now, b_now):
    if a_now is None or b_now is None:
        return {"leader": None, "difference_pct": None}
    if a_now == b_now:
        return {"leader": "tie", "difference_pct": 0}
    leader = "a" if a_now > b_now else "b"
    base = min(a_now, b_now) or 1
    diff_pct = round(abs(a_now - b_now) / base * 100, 1)
    return {"leader": leader, "difference_pct": diff_pct}


@router.post("/")
async def compare_cities(req: CompareRequest):
    data_a, data_b = await asyncio.gather(
        get_predictions(
            req.location_a.lat,
            req.location_a.lon,
            place_name=req.location_a.boundary_query or req.location_a.name,
            level=req.location_a.level,
            country_code=req.location_a.country_code,
        ),
        get_predictions(
            req.location_b.lat,
            req.location_b.lon,
            place_name=req.location_b.boundary_query or req.location_b.name,
            level=req.location_b.level,
            country_code=req.location_b.country_code,
        ),
    )

    metrics = ["population", "aqi", "weather", "migration"]
    comparison = {}
    for m in metrics:
        a_now = data_a.get(m, {}).get("current")
        b_now = data_b.get(m, {}).get("current")
        comparison[m] = {
            "a": a_now,
            "b": b_now,
            **_diff_metric(a_now, b_now),
        }

    stress_a = data_a.get("urban_stress_score", {}).get("current")
    stress_b = data_b.get("urban_stress_score", {}).get("current")
    comparison["urban_stress_score"] = {
        "a": stress_a,
        "b": stress_b,
        **_diff_metric(stress_a, stress_b),
    }

    summary_prompt = (
        f"Compare these two locations using ONLY this real data: "
        f"{req.location_a.name}: {comparison}. "
        f"Write a 4-5 sentence comparison summary. Be specific about which place "
        f"leads on which metric and by roughly how much. Note one meaningful "
        f"tradeoff a visitor or resident should weigh. No headings, no bullet points, "
        f"do not invent facts beyond what's given."
    )
    try:
        res = _groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": summary_prompt}],
        )
        ai_summary = res.choices[0].message.content
    except Exception:
        ai_summary = None

    return {
        "location_a": {"name": req.location_a.name, "lat": req.location_a.lat, "lon": req.location_a.lon},
        "location_b": {"name": req.location_b.name, "lat": req.location_b.lat, "lon": req.location_b.lon},
        "comparison": comparison,
        "ai_summary": ai_summary,
    }