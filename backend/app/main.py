import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import location, predictions, story, report, clusters, ask, disasters, compare, sustainability, agentic, recommend, remotesensing, timemachine

app = FastAPI(title="GeoVisionAI API")

# CORS — allow localhost for dev, Vercel URL for production.
# Set ALLOWED_ORIGINS env var on Render to your real Vercel URL.
# Multiple origins can be comma-separated: https://a.vercel.app,https://b.vercel.app
_raw_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:5174")
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(location.router, prefix="/api/location", tags=["location"])
app.include_router(predictions.router, prefix="/api/predictions", tags=["predictions"])
app.include_router(story.router, prefix="/api/story", tags=["story"])
app.include_router(report.router, prefix="/api/report", tags=["report"])
app.include_router(clusters.router, prefix="/api/clusters", tags=["clusters"])
app.include_router(ask.router, prefix="/api/ask", tags=["ask"])
app.include_router(disasters.router, prefix="/api/disasters", tags=["disasters"])
app.include_router(compare.router, prefix="/api/compare", tags=["compare"])
app.include_router(sustainability.router, prefix="/api/sustainability", tags=["sustainability"])
app.include_router(agentic.router, prefix="/api/agent", tags=["agentic"])
app.include_router(recommend.router, prefix="/api/recommend", tags=["recommend"])
app.include_router(remotesensing.router, prefix="/api/remotesensing", tags=["remotesensing"])
app.include_router(timemachine.router, prefix="/api/timemachine", tags=["timemachine"])


@app.get("/")
def root():
    return {"status": "GeoVisionAI backend running", "version": "1.0"}