"""
train.py — trains the Mental Health Score model.

Same steps as ML_Project.ipynb, as a plain Python script:
  1. Load and explore the dataset
  2. Clean it (duplicates, negative values, rare countries)
  3. Build the preprocessing pipeline
  4. Train Linear Regression and Random Forest, compare them
  5. Tune the Random Forest with RandomizedSearchCV
  6. Save the model to Mental_Health_Model.pkl (used by main.py)

Run:  python3 train.py
"""

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import RandomizedSearchCV, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import FunctionTransformer, OneHotEncoder, OrdinalEncoder, StandardScaler

DATA_PATH = 'Student Social Media And Mental Health Impact.csv'
MODEL_PATH = 'Mental_Health_Model.pkl'


# ---------------------------------------------------------------
# 1. Load and explore
# ---------------------------------------------------------------
df = pd.read_csv(DATA_PATH)

print("Shape:", df.shape)
print("\nMissing values per column:\n", df.isnull().sum())
print("\nDuplicate rows:", df.duplicated().sum())

# Outliers with the IQR rule: below Q1 - 1.5*IQR or above Q3 + 1.5*IQR
num_features = df.select_dtypes(include='number')
Q1, Q3 = num_features.quantile(0.25), num_features.quantile(0.75)
IQR = Q3 - Q1
outliers = (num_features < Q1 - 1.5 * IQR) | (num_features > Q3 + 1.5 * IQR)
print("\nOutliers per numeric column (IQR rule):\n", outliers.sum())


# ---------------------------------------------------------------
# 2. Clean
# ---------------------------------------------------------------
df = df.drop_duplicates()

# Negative hours are impossible -> set them to 0
df['Physical_Activity_Hours'] = df['Physical_Activity_Hours'].clip(lower=0)

# Skewness: near 0 = balanced, > 0 = right-skewed, < 0 = left-skewed
print("\nSkewness:\n", df.select_dtypes(include='number').skew())

# Keep the 10 most common countries, group the rest as 'Other'
top_countries = df['Country'].value_counts().index[:10].tolist()
df['Grouped_country'] = df['Country'].apply(lambda c: c if c in top_countries else 'Other')

print("\nRows after cleaning:", len(df))


# ---------------------------------------------------------------
# 3. Features, train/test split, preprocessing
# ---------------------------------------------------------------
skewed_col         = ['Study_Hours']
other_numeric_cols = ['Age', 'Avg_Daily_Usage_Hours', 'Daily_Unlocks',
                      'Physical_Activity_Hours', 'Sleep_Hours_Per_Night']
ordinal_col        = ['Stress_Level']
nominal_cols       = ['Gender', 'Academic_Level', 'Most_Used_Platform', 'Purpose_Of_Use', 'Grouped_country']

feature_cols = skewed_col + other_numeric_cols + ordinal_col + nominal_cols
X = df[feature_cols]
y = df['Mental_Health_Score']

# 70% train, 30% test; random_state=42 makes the split the same every run
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.30, random_state=42)

preprocessor = ColumnTransformer(transformers=[
    # Skewed numeric: log(1 + x) to reduce skew, then scale
    ('Skewed_Pipeline', Pipeline([('log_transform', FunctionTransformer(np.log1p)),
                                  ('scale', StandardScaler())]), skewed_col),
    # Other numeric: scale to mean 0, std 1
    ('Plain_Numeric', Pipeline([('scale', StandardScaler())]), other_numeric_cols),
    # Ordinal: Low < Medium < High < Very High  ->  0, 1, 2, 3
    ('Ordinal', Pipeline([('encode', OrdinalEncoder(categories=[['Low', 'Medium', 'High', 'Very High']]))]),
     ordinal_col),
    # Nominal: one 0/1 column per category; unseen categories are ignored instead of crashing
    ('Normal', Pipeline([('encode', OneHotEncoder(handle_unknown='ignore'))]), nominal_cols),
])


def evaluate(name, pipeline):
    """Return train R2, test R2, MAE and RMSE for a fitted pipeline."""
    test_preds = pipeline.predict(X_test)
    train_preds = pipeline.predict(X_train)
    return {
        'Model': name,
        'Training R2': r2_score(y_train, train_preds),
        'R2': r2_score(y_test, test_preds),
        'MAE': mean_absolute_error(y_test, test_preds),
        'RMSE': np.sqrt(mean_squared_error(y_test, test_preds)),
    }


# ---------------------------------------------------------------
# 4. Linear Regression vs Random Forest
# ---------------------------------------------------------------
lr_pipeline = Pipeline([('preprocessor', preprocessor), ('regressor', LinearRegression())])
lr_pipeline.fit(X_train, y_train)

rf_pipeline = Pipeline([('preprocessor', preprocessor),
                        ('random forest', RandomForestRegressor(random_state=42))])
rf_pipeline.fit(X_train, y_train)


# ---------------------------------------------------------------
# 5. Hyperparameter tuning (5-fold cross-validation, 15 random combinations)
# ---------------------------------------------------------------
param_grid = {
    'random forest__n_estimators':      [100, 200, 300],
    'random forest__max_depth':         [5, 10, 15],
    'random forest__min_samples_split': [2, 5, 10],
    'random forest__min_samples_leaf':  [1, 2, 4],
}
print("\nTuning Random Forest (this can take a few minutes)...")
random_search = RandomizedSearchCV(rf_pipeline, param_distributions=param_grid, n_iter=15, cv=5,
                                   scoring='r2', random_state=42, n_jobs=-1)
random_search.fit(X_train, y_train)
print("Best parameters:", random_search.best_params_)

results = pd.DataFrame([
    evaluate('Linear Regression', lr_pipeline),
    evaluate('Random Forest (default)', rf_pipeline),
    evaluate('Random Forest (tuned)', random_search.best_estimator_),
])
print("\nResults on the test set:")
print(results.round(3).to_string(index=False))


# ---------------------------------------------------------------
# 6. Save the model used by the app (preprocessing + model in one file)
# ---------------------------------------------------------------
joblib.dump(rf_pipeline, MODEL_PATH)
print(f"\nSaved the default Random Forest pipeline to {MODEL_PATH}")
