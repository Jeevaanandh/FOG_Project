#This is the main backend that takes requests from the ESP and sends data to the frontend.

from fastapi import FastAPI
from pydantic import BaseModel

from FOGInference import process_new_reading

app = FastAPI()

window_readings=[]

class Item(BaseModel):
    temperature: float
    humidity: float
    co2_ppm: float

@app.post("/items")
async def create_item(item: Item):
    global window_readings
    print(item)

    window_readings.append(item)
    if(len(window_readings)==5):
        res=process_new_reading(window_readings)
        print(res)
        window_readings=[]

    
    return {"message": "Item received", "item": item}