# backend/app/routers/report.py
import io
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import cm

router = APIRouter()


class ReportRequest(BaseModel):
    location_name: str
    predictions: dict
    story: str


@router.post("/generate")
async def generate_report(req: ReportRequest):
    buffer = io.BytesIO()
    p = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4

    y = height - 2 * cm

    p.setFont("Helvetica-Bold", 18)
    p.drawString(2 * cm, y, "GeoVisionAI Report")
    y -= 1 * cm

    p.setFont("Helvetica-Bold", 14)
    p.drawString(2 * cm, y, req.location_name)
    y -= 1.2 * cm

    p.setFont("Helvetica-Bold", 12)
    p.drawString(2 * cm, y, "Key Metrics")
    y -= 0.7 * cm

    p.setFont("Helvetica", 10)
    aqi = req.predictions.get("aqi", {})
    pop = req.predictions.get("population", {})
    green = req.predictions.get("green_cover", {})
    stress = req.predictions.get("urban_stress_score", {})

    lines = [
        f"Current AQI: {aqi.get('current')}",
        f"Current Population: {pop.get('current')}",
        f"Current Green Cover (NDVI): {green.get('current')}",
        f"Urban Stress Score: {stress.get('current')} / 100",
    ]
    for line in lines:
        p.drawString(2 * cm, y, line)
        y -= 0.6 * cm

    y -= 0.5 * cm
    p.setFont("Helvetica-Bold", 12)
    p.drawString(2 * cm, y, "AI-Generated Insight")
    y -= 0.7 * cm

    p.setFont("Helvetica", 9)
    text = p.beginText(2 * cm, y)
    text.setLeading(13)

    max_chars = 95
    words = req.story.split()
    line = ""
    for word in words:
        if len(line) + len(word) + 1 > max_chars:
            text.textLine(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        text.textLine(line)

    p.drawText(text)
    p.showPage()
    p.save()

    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={req.location_name}_report.pdf"},
    )