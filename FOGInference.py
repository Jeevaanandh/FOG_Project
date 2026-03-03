import joblib
import numpy as np
import pandas as pd
from collections import deque

# Load trained model
model = joblib.load("isolation_forest_model.pkl")

baseline_mu = joblib.load("baseline_mu.pkl")
baseline_sigma = joblib.load("baseline_sigma.pkl")

WINDOW_SIZE = 5

buffer = deque(maxlen=WINDOW_SIZE)

def compute_slope(x):
    N = len(x)
    i = np.arange(1, N+1)
    i_bar = np.mean(i)
    x_bar = np.mean(x)
    return np.sum((i - i_bar)*(x - x_bar)) / np.sum((i - i_bar)**2)

def extract_features(window_df):
    features = []

    for field in ['field3','field4','field5','field7']:
        values = window_df[field].values

        mean = np.mean(values)
        std = np.std(values)
        slope = compute_slope(values)

        features.append(mean)
        features.append(std)
        features.append(slope)

    return np.array(features)


def process_new_reading(temp, humidity, eco2, dust):

    # Add new reading to buffer
    buffer.append({
        'field3': temp,
        'field4': humidity,
        'field5': eco2,
        'field7': dust
    })

    # Wait until buffer full
    if len(buffer) < WINDOW_SIZE:
        return "Waiting for full window..."

    # Convert to DataFrame
    window_df = pd.DataFrame(buffer)

    # Extract features
    features = extract_features(window_df)

    # Normalize using training baseline
    z_features = (features - baseline_mu) / baseline_sigma

    # Reshape for model
    z_features = z_features.values.reshape(1, -1)
    

    # Predict
    score = model.decision_function(z_features)[0]
    label = model.predict(z_features)[0]

    # Interpret
    if score > 0.05:
        status = "NORMAL"
    elif score > 0:
        status = "WATCH"
    else:
        status = "ANOMALY"

    return {
        "score": score,
        "label": label,
        "status": status
    }



print(process_new_reading(32.8, 51, 620, 430))
print(process_new_reading(33.0, 50, 640, 410))
print(process_new_reading(33.1, 52, 650, 420))
print(process_new_reading(33.3, 53, 660, 415))
print(process_new_reading(33.5, 54, 670, 405))