# Mental Health Score Predictor

Predicts a student's mental health score (0–10) from their social media usage, sleep, study and activity habits.

- **Backend:** FastAPI serving a scikit-learn Random Forest pipeline (`Mental_Health_Model.pkl`)
- **Frontend:** plain HTML/CSS/JS (`index.html`) that calls the API
- **Training:** `train.py` (same steps as `ML_Project.ipynb`) on the *Student Social Media And Mental Health Impact* dataset

> Based on [tanishq-latent/Mental-Health-Score](https://github.com/tanishq-latent/Mental-Health-Score).

## Features

1. **Why this score?**: shows how much each input raised or lowered the prediction compared with a typical student in the dataset. For each input, the app swaps in the typical value and re-runs the model (an occlusion-style explanation).
2. **What-if sliders**: change sleep, screen time, phone unlocks, study, activity and stress, and the score updates live.
3. **Personalised tips**: compares you with students who scored 7+, and uses the model to estimate how much each change would move your score.
4. **Out-of-range warnings**: flags inputs outside the training data, where the model can't be trusted.
5. **History**: every reading is saved to SQLite and shown as a line chart.
6. **Model stats**: compares Linear Regression, Decision Tree and Random Forest (R², MAE and RMSE on the same 70/30 split as the notebook) and shows feature importance.

## API

| Method | Route | What it does |
|---|---|---|
| `POST` | `/predict` | Score only |
| `POST` | `/analyze` | Score + explanation + tips + warnings (saved to history; add `?save=false` to skip saving) |
| `GET` | `/health` | Health check |
| `GET` | `/model-stats` | Model comparison + feature importance |
| `GET` | `/history` | Saved readings |
| `DELETE` | `/history` | Clear history |

## Run locally

Requires Python 3.10+.

```bash
git clone https://github.com/adi542/<your-repo-name>.git
cd <your-repo-name>
python -m venv venv
# Windows:      venv\Scripts\activate
# Mac / Linux:  source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Then open **http://127.0.0.1:8000**. The same server hosts the website and the API (interactive API docs at http://127.0.0.1:8000/docs).

## Retrain the model

```bash
python3 train.py
```

Cleans the data, compares Linear Regression and Random Forest, tunes the Random Forest with 5-fold cross-validation, and saves `Mental_Health_Model.pkl` (takes about a minute).

## Deploy (Render, free)

The repo includes `render.yaml` and `.python-version`, so Render can set everything up automatically:

1. Sign in at [render.com](https://render.com) with GitHub.
2. **New → Blueprint**, pick this repo, and click **Apply**.
3. Wait for the build to finish and open the `onrender.com` link.

Notes: the free plan sleeps after ~15 minutes without visitors, so the first visit can take up to a minute. The history database lives on Render's temporary disk, so it resets when the service restarts or redeploys.

## Example request

`POST /predict`

```json
{
  "age": 20,
  "gender": "Male",
  "country": "India",
  "academic_level": "Undergraduate",
  "most_used_platform": "Instagram",
  "purpose_of_use": "Entertainment",
  "avg_daily_usage_hours": 5,
  "daily_unlocks": 80,
  "study_hours": 3,
  "physical_activity_hours": 1,
  "sleep_hours_per_night": 6,
  "stress_level": "High"
}
```

Response:

```json
{ "predicted_mental_health_score": 5.68 }
```

## Disclaimer

This is a learning project trained on a small survey dataset. It is not a medical or psychological assessment.
