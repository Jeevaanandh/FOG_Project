import joblib
import numpy as np
import pandas as pd
from collections import deque
import random

# Load trained model
model = joblib.load("isolation_forest_model.pkl")

baseline_mu = joblib.load("baseline_mu.pkl")
baseline_sigma = joblib.load("baseline_sigma.pkl")

WINDOW_SIZE = 5

buffer = deque(maxlen=WINDOW_SIZE)

#Loading the T matrix (Downloaded it from google colab)
T = joblib.load("transition_matrix.pkl")


def generate_dust_reading():
    return round(random.uniform(0, 500), 2)

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




def fault_probabilities(z_features):
    # z_features must be numpy array of 12 features

    z = z_features.flatten()

    # Indices based on feature order
    # [f3_mean,f3_std,f3_slope,
    #  f4_mean,f4_std,f4_slope,
    #  f5_mean,f5_std,f5_slope,
    #  f7_mean,f7_std,f7_slope]

    E_thermal = max(0, z[0]) + max(0, z[3])
    E_co2     = max(0, z[6])
    E_dust    = max(0, z[9])
    E_sensor  = max(0, z[1]) + max(0, z[10])

    evidence = np.array([E_thermal, E_co2, E_dust, E_sensor])

    # Softmax
    exp_vals = np.exp(evidence)
    probs = exp_vals / np.sum(exp_vals)

    return probs  # [P_Thermal, P_CO2, P_Dust, P_Sensor]


def future_risk(P_A, fault_probs, steps):

    # Initial state vector
    state = np.array([
        1 - P_A,
        P_A * fault_probs[0],
        P_A * fault_probs[1],
        P_A * fault_probs[2],
        P_A * fault_probs[3]
    ])

    for _ in range(steps):
        state = state @ T

    # Risk = probability of being in any fault state
    return state[1:].sum()


#This function is used to get the probability of the score output by Isolation Forest. (Previously we were doing it manually)
def anomaly_probability(score):
    return 1 / (1 + np.exp(5 * score))


def process_new_reading(readings):

    # Add new reading to buffer
    for reading in readings:
        dust= generate_dust_reading()
        temp= reading.temperature
        humidity= reading.humidity
        co2= reading.co2_ppm

        buffer.append({
            'field3': temp,
            'field4': humidity,
            'field5': co2,
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

    P_A= anomaly_probability(score)


    fault_probs = fault_probabilities(z_features)

    risk_10  = future_risk(P_A, fault_probs, 2)  # ~10 min
    risk_15  = future_risk(P_A, fault_probs, 3)
    risk_30  = future_risk(P_A, fault_probs, 6)

    if P_A < 0.2:
        alert = "GREEN"
    elif P_A < 0.5:
        alert = "YELLOW"
    else:
        alert = "RED"

    last = buffer[-1]

    return {
        # Sensor values (for display cards + log table)
        "temp":     round(last['field3'], 2),
        "humidity": round(last['field4'], 2),
        "eco2":     round(last['field5'], 2),
        "dust":     round(last['field7'], 2),

        # Model outputs
        "score":      float(score),
        "P_A":        float(P_A),
        "Risk_10min": float(risk_10),
        "Risk_15min": float(risk_15),
        "Risk_30min": float(risk_30),

        # Fault probabilities
        "P_Thermal": float(fault_probs[0]),
        "P_CO2":     float(fault_probs[1]),
        "P_Dust":    float(fault_probs[2]),
        "P_Sensor":  float(fault_probs[3]),

        # Alert + timestamp
        "alert":     alert,
        "timestamp": pd.Timestamp.now().isoformat(),
    }