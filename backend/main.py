from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
import asyncio
import json

from FOGInference import process_new_reading

app = FastAPI()

window_readings = []
connected_clients: list[WebSocket] = []  # track all connected frontends

class Item(BaseModel):
    temperature: float
    humidity: float
    co2_ppm: float

# ── WebSocket endpoint (frontend connects here) ────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.append(websocket)
    print(f"Frontend connected. Total clients: {len(connected_clients)}")
    try:
        while True:
            await asyncio.sleep(1)  # keep connection alive
    except WebSocketDisconnect:
        connected_clients.remove(websocket)
        print("Frontend disconnected.")

# ── Broadcast helper ───────────────────────────────────────────────────────────
async def broadcast(data: dict):
    disconnected = []
    for client in connected_clients:
        try:
            await client.send_text(json.dumps(data))
        except Exception:
            disconnected.append(client)
    for c in disconnected:
        connected_clients.remove(c)

# ── ESP32 POST endpoint ────────────────────────────────────────────────────────
@app.post("/items")
async def create_item(item: Item):
    global window_readings
    window_readings.append(item)

    if len(window_readings) == 5:
        res = process_new_reading(window_readings)
        print(res)
        await broadcast(res)  # send to all connected frontends
        window_readings = []

    return {"message": "Item received", "item": item}