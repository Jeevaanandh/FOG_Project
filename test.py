import joblib
import numpy as np

model = joblib.load("isolation_forest_model.pkl")
print(model.get_params())

# Example: 1 sample with correct number of features
X_test = np.random.rand(1, model.n_features_in_)

score = model.decision_function(X_test)
label = model.predict(X_test)

baseline_mu = joblib.load("baseline_mu.pkl")

print(baseline_mu)

