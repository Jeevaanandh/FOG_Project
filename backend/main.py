#This is the main backend that takes requests from the ESP and sends data to the frontend.

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class Item(BaseModel):
    temperature: float
    humidity: float
    co2_ppm: float

@app.post("/items")
async def create_item(item: Item):
    print(item)
    return {"message": "Item received", "item": item}