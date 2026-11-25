import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Literal

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sklearn.base import clone
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.tree import DecisionTreeRegressor

BASE_DIR = Path(__file__).parent
DATA_PATH = BASE_DIR / "Student Social Media And Mental Health Impact.csv"
DB_PATH = BASE_DIR / "history.db"

model = joblib.load(BASE_DIR / "Mental_Health_Model.pkl")
top_countries = ['Other', 'India', 'USA', 'Canada', 'Australia', 'UK', 'Germany', 'Mexico', 'Turkey', 'France']

# Same feature order and cleaning as the training notebook
FEATURES = ['Study_Hours', 'Age', 'Avg_Daily_Usage_Hours', 'Daily_Unlocks', 'Physical_Activity_Hours',
            'Sleep_Hours_Per_Night', 'Stress_Level', 'Gender', 'Academic_Level', 'Most_Used_Platform',
            'Purpose_Of_Use', 'Grouped_country']
NUMERIC = ['Study_Hours', 'Age', 'Avg_Daily_Usage_Hours', 'Daily_Unlocks',
           'Physical_Activity_Hours', 'Sleep_Hours_Per_Night']

LABELS = {
    'Study_Hours': 'Study hours',
    'Age': 'Age',
    'Avg_Daily_Usage_Hours': 'Screen time',
    'Daily_Unlocks': 'Phone unlocks',
    'Physical_Activity_Hours': 'Physical activity',
    'Sleep_Hours_Per_Night': 'Sleep',
    'Stress_Level': 'Stress level',
    'Gender': 'Gender',
    'Academic_Level': 'Academic level',
    'Most_Used_Platform': 'Platform',
    'Purpose_Of_Use': 'Purpose of use',
    'Grouped_country': 'Country',
}
UNITS = {'Study_Hours': 'hrs', 'Avg_Daily_Usage_Hours': 'hrs', 'Physical_Activity_Hours': 'hrs',
         'Sleep_Hours_Per_Night': 'hrs', 'Daily_Unlocks': '/day', 'Age': 'yrs'}


def load_dataset():
    df = pd.read_csv(DATA_PATH).drop_duplicates()
    df['Physical_Activity_Hours'] = df['Physical_Activity_Hours'].clip(lower=0)
    df['Grouped_country'] = df['Country'].where(df['Country'].isin(top_countries), 'Other')
    return df


df = load_dataset()

# A "typical student": median for numbers, most common value for categories
TYPICAL = {c: (float(df[c].median()) if c in NUMERIC else df[c].mode()[0]) for c in FEATURES}
RANGES = {c: (float(df[c].min()), float(df[c].max())) for c in NUMERIC}

# Students who scored 7+ — used as the reference group for tips
HEALTHY = df[df['Mental_Health_Score'] >= 7]


# ---------------------------------------------------------------
# Database for prediction history
# ---------------------------------------------------------------
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


with db() as conn:
    conn.execute("""CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        inputs TEXT NOT NULL,
        score REAL NOT NULL
    )""")


app = FastAPI(title="Mental Health Score API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class StudentData(BaseModel):
    age                     : int = Field(..., ge=10, le=100)
    gender                  : Literal['Male', 'Female']
    country                 : str
    academic_level          : Literal['Undergraduate', 'Graduate', 'High School']
    most_used_platform      : Literal['Facebook', 'LinkedIn', 'Instagram', 'Snapchat', 'Twitter', 'YouTube', 'TikTok', 'LINE', 'KakaoTalk', 'VKontakte', 'WhatsApp', 'WeChat']
    purpose_of_use          : Literal['Networking', 'Education', 'Entertainment', 'News']
    avg_daily_usage_hours   : float = Field(..., ge=0, le=24)
    daily_unlocks           : int   = Field(..., ge=0)
    study_hours             : float = Field(..., ge=0, le=24)
    physical_activity_hours : float = Field(..., ge=0, le=24)
    sleep_hours_per_night   : float = Field(..., ge=0, le=24)
    stress_level            : Literal['Medium', 'Low', 'Very High', 'High']


class PredictionResponse(BaseModel):
    predicted_mental_health_score: float


def to_row(data: StudentData) -> dict:
    return {
        'Age': data.age,
        'Gender': data.gender,
        'Country': data.country,
        'Academic_Level': data.academic_level,
        'Most_Used_Platform': data.most_used_platform,
        'Purpose_Of_Use': data.purpose_of_use,
        'Avg_Daily_Usage_Hours': data.avg_daily_usage_hours,
        'Daily_Unlocks': data.daily_unlocks,
        'Study_Hours': data.study_hours,
        'Physical_Activity_Hours': data.physical_activity_hours,
        'Sleep_Hours_Per_Night': data.sleep_hours_per_night,
        'Stress_Level': data.stress_level,
        'Grouped_country': data.country if data.country in top_countries else 'Other',
    }


def predict_rows(rows: list[dict]) -> np.ndarray:
    return model.predict(pd.DataFrame(rows)[FEATURES])


def fmt(feature, value):
    if feature in NUMERIC:
        v = int(value) if feature in ('Age', 'Daily_Unlocks') else round(float(value), 1)
        unit = UNITS[feature]
        return f"{v}{unit}" if unit.startswith('/') else f"{v} {unit}"
    return str(value)


# ---------------------------------------------------------------
# Feature 1: "Why this score?" — how much each input moves the
# prediction compared to a typical student (occlusion method)
# ---------------------------------------------------------------
def explain(row: dict, score: float) -> list[dict]:
    variants = []
    for f in FEATURES:
        r = dict(row)
        r[f] = TYPICAL[f]
        variants.append(r)
    baseline_preds = predict_rows(variants)
    out = []
    for f, base in zip(FEATURES, baseline_preds):
        out.append({
            'feature': f,
            'label': LABELS[f],
            'value': fmt(f, row[f]),
            'typical': fmt(f, TYPICAL[f]),
            'impact': round(float(score - base), 2),
        })
    out.sort(key=lambda x: abs(x['impact']), reverse=True)
    return out


# ---------------------------------------------------------------
# Feature 3: personalised tips, backed by the dataset + the model
# ---------------------------------------------------------------
TIP_RULES = [
    # feature, direction (+1 = more is better), text template
    ('Sleep_Hours_Per_Night', +1, "You sleep {you}. Students who scored 7+ sleep about {target} on average."),
    ('Avg_Daily_Usage_Hours', -1, "Your screen time is {you}. Students who scored 7+ average about {target}."),
    ('Daily_Unlocks', -1, "You unlock your phone {you}. Students who scored 7+ average about {target}."),
    ('Physical_Activity_Hours', +1, "You get {you} of physical activity. Students who scored 7+ average about {target}."),
    ('Study_Hours', +1, "You study {you} a day. Students who scored 7+ average about {target}."),
]
STRESS_ORDER = ['Low', 'Medium', 'High', 'Very High']


def tips_for(row: dict, score: float) -> list[dict]:
    tips = []
    for f, direction, template in TIP_RULES:
        target = float(HEALTHY[f].mean())
        if f == 'Daily_Unlocks':
            target = round(target)
        else:
            target = round(target, 1)
        if (target - row[f]) * direction <= 0:
            continue  # already at or better than the healthy group
        changed = dict(row)
        changed[f] = target
        new_score = float(predict_rows([changed])[0])
        gain = new_score - score
        if gain >= 0.05:
            action = f"Moving to {fmt(f, target)} would change your predicted score from {score:.2f} to {new_score:.2f}."
        else:
            action = (f"The model barely reacts to this ({score:.2f} → {new_score:.2f}), because it leans heavily on "
                      f"screen time, but the gap from the 7+ group is still real.")
        tips.append({
            'feature': LABELS[f],
            'text': template.format(you=fmt(f, row[f]), target=fmt(f, target)),
            'action': action,
            'gain': round(gain, 2),
            # how far off the healthy group, relative to the spread in the data
            'gap': abs(target - row[f]) / float(df[f].std()),
        })

    level = STRESS_ORDER.index(row['Stress_Level'])
    if level >= 2:
        changed = dict(row)
        changed['Stress_Level'] = 'Medium'
        new_score = float(predict_rows([changed])[0])
        if new_score - score >= 0.05:
            avg = df.groupby('Stress_Level')['Mental_Health_Score'].mean()
            tips.append({
                'feature': LABELS['Stress_Level'],
                'text': f"Students reporting '{row['Stress_Level']}' stress average {avg[row['Stress_Level']]:.1f}/10, versus {avg['Medium']:.1f} for 'Medium'.",
                'action': f"If your stress came down to Medium, your predicted score would go from {score:.2f} to {new_score:.2f}.",
                'gain': round(new_score - score, 2),
                'gap': 1.0,
            })

    # Tips the model agrees with first (biggest gain), then the biggest gaps from the 7+ group
    tips = [t for t in tips if t['gain'] >= 0.05 or t['gap'] >= 0.5]
    tips.sort(key=lambda t: (t['gain'] >= 0.05, t['gain'] if t['gain'] >= 0.05 else t['gap']), reverse=True)
    for t in tips:
        t.pop('gap')
    return tips[:3]


def warnings_for(row: dict) -> list[str]:
    out = []
    for f in NUMERIC:
        lo, hi = RANGES[f]
        v = row[f]
        if v < lo or v > hi:
            side = 'below' if v < lo else 'above'
            out.append(f"{LABELS[f]} ({fmt(f, v)}) is {side} anything in the training data "
                       f"({fmt(f, lo)} – {fmt(f, hi)}). The model can't extrapolate, so treat this score with caution.")
    return out


# ---------------------------------------------------------------
# Feature 4: model stats — retrain baselines on the notebook's split
# ---------------------------------------------------------------
_model_stats = None


def compute_model_stats():
    X, y = df[FEATURES], df['Mental_Health_Score']
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.30, random_state=42)
    preprocessor = model.named_steps['preprocessor']

    candidates = {
        'Linear Regression': Pipeline([('preprocessor', clone(preprocessor)), ('reg', LinearRegression())]),
        'Decision Tree': Pipeline([('preprocessor', clone(preprocessor)),
                                   ('reg', DecisionTreeRegressor(random_state=42))]),
    }
    results = []
    for name, pipe in candidates.items():
        pipe.fit(X_train, y_train)
        results.append((name, pipe, False))
    results.append(('Random Forest', model, True))  # the saved model, not retrained

    models = []
    for name, pipe, in_use in results:
        pred_test, pred_train = pipe.predict(X_test), pipe.predict(X_train)
        models.append({
            'name': name,
            'in_use': in_use,
            'r2_test': round(float(r2_score(y_test, pred_test)), 3),
            'r2_train': round(float(r2_score(y_train, pred_train)), 3),
            'mae': round(float(mean_absolute_error(y_test, pred_test)), 3),
            'rmse': round(float(np.sqrt(mean_squared_error(y_test, pred_test))), 3),
        })

    # Random Forest feature importance, one-hot columns summed back to the original feature
    # Work out which original feature each output column came from
    # (the log transform step doesn't support get_feature_names_out)
    source = []
    for name, trans, cols in preprocessor.transformers_:
        if name == 'remainder' or trans == 'drop':
            continue
        last = trans.steps[-1][1] if isinstance(trans, Pipeline) else trans
        if hasattr(last, 'categories_') and last.__class__.__name__ == 'OneHotEncoder':
            for col, cats in zip(cols, last.categories_):
                source += [col] * len(cats)
        else:
            source += list(cols)
    importances = model.named_steps['random forest'].feature_importances_
    totals = {f: 0.0 for f in FEATURES}
    for col, imp in zip(source, importances):
        totals[col] += float(imp)
    importance = sorted(({'label': LABELS[f], 'importance': round(v, 4)} for f, v in totals.items()),
                        key=lambda x: x['importance'], reverse=True)

    return {
        'dataset_rows': int(len(df)),
        'train_rows': int(len(X_train)),
        'test_rows': int(len(X_test)),
        'models': models,
        'feature_importance': importance,
    }


# ---------------------------------------------------------------
# Routes
# ---------------------------------------------------------------
# ---- Website (served by the same server, so one deploy gives one link) ----
@app.get('/', include_in_schema=False)
def home():
    return FileResponse(BASE_DIR / 'index.html')


@app.get('/style.css', include_in_schema=False)
def stylesheet():
    return FileResponse(BASE_DIR / 'style.css', media_type='text/css')


@app.get('/script.js', include_in_schema=False)
def javascript():
    return FileResponse(BASE_DIR / 'script.js', media_type='application/javascript')


@app.get('/health')
def health():
    return {'status': 'ok', 'message': 'Mental Health Score API is running. Open /docs to try it.'}


@app.post('/predict', response_model=PredictionResponse)
def predict(data: StudentData):
    prediction = predict_rows([to_row(data)])[0]
    return PredictionResponse(predicted_mental_health_score=round(float(prediction), 2))


@app.post('/analyze')
def analyze(data: StudentData, save: bool = True):
    """Score + explanation + tips + warnings. Saves to history unless save=false."""
    row = to_row(data)
    score = float(predict_rows([row])[0])
    entry_id = None
    if save:
        with db() as conn:
            cur = conn.execute(
                "INSERT INTO history (created_at, inputs, score) VALUES (?, ?, ?)",
                (datetime.now().isoformat(timespec='seconds'), data.model_dump_json(), round(score, 2)),
            )
            entry_id = cur.lastrowid
    return {
        'score': round(score, 2),
        'contributions': explain(row, score),
        'tips': tips_for(row, score),
        'warnings': warnings_for(row),
        'history_id': entry_id,
    }


@app.get('/model-stats')
def model_stats():
    global _model_stats
    if _model_stats is None:
        _model_stats = compute_model_stats()
    return _model_stats


@app.get('/history')
def history(limit: int = 50):
    with db() as conn:
        rows = conn.execute(
            "SELECT id, created_at, inputs, score FROM history ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    items = [{'id': r['id'], 'created_at': r['created_at'], 'score': r['score'],
              'inputs': json.loads(r['inputs'])} for r in rows]
    return list(reversed(items))  # oldest first, for charting


@app.delete('/history')
def clear_history():
    with db() as conn:
        conn.execute("DELETE FROM history")
    return {'cleared': True}
