---
name: data_science
description: Pandas/NumPy analysis, scikit-learn and deep-learning training, notebooks and feature engineering. Use for data analysis, model training, or .ipynb work.
---

## Data Science Expert Context

You are working on data analysis, machine learning, or data engineering with Python.

### Data Loading & Exploration
```python
import pandas as pd
import numpy as np

df = pd.read_csv('data.csv', parse_dates=['created_at'])

# First steps — always do these before anything else
print(df.shape)          # rows × columns
df.dtypes                # check types are correct
df.isnull().sum()        # count missing values per column
df.describe()            # stats for numeric columns
df.head()                # look at actual data
```

### Data Cleaning
```python
# Missing values
df['age'].fillna(df['age'].median(), inplace=True)  # or drop:
df.dropna(subset=['critical_column'], inplace=True)

# Type casting
df['price'] = pd.to_numeric(df['price'], errors='coerce')  # coerce = NaN on failure
df['date'] = pd.to_datetime(df['date'], format='%Y-%m-%d')

# Remove duplicates
df.drop_duplicates(subset=['user_id', 'event_type'], inplace=True)

# String normalization
df['email'] = df['email'].str.lower().str.strip()
```

### Transformations
```python
# Group and aggregate
summary = df.groupby('category').agg(
    total_sales=('revenue', 'sum'),
    avg_price=('price', 'mean'),
    count=('id', 'count'),
).reset_index()

# Apply function per row (slow — use vectorized ops when possible)
df['label'] = df['score'].apply(lambda x: 'high' if x > 0.7 else 'low')

# Vectorized is faster
df['label'] = np.where(df['score'] > 0.7, 'high', 'low')

# Merge datasets
merged = pd.merge(orders, customers, on='customer_id', how='left')
```

### Machine Learning (scikit-learn)
```python
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report

X = df.drop('target', axis=1)
y = df['target']

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Always scale for distance-based models (not needed for tree models)
scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)  # fit ONLY on train set
X_test_scaled = scaler.transform(X_test)         # transform test with train stats

model = RandomForestClassifier(n_estimators=100, random_state=42)
model.fit(X_train_scaled, y_train)

print(classification_report(y_test, model.predict(X_test_scaled)))
```

### Visualization
```python
import matplotlib.pyplot as plt
import seaborn as sns

fig, axes = plt.subplots(1, 2, figsize=(12, 5))

# Distribution
axes[0].hist(df['price'], bins=30, edgecolor='black')
axes[0].set_title('Price Distribution')

# Correlation heatmap
sns.heatmap(df.select_dtypes('number').corr(), annot=True, fmt='.2f', ax=axes[1])

plt.tight_layout()
plt.savefig('analysis.png', dpi=150, bbox_inches='tight')
plt.show()
```

### Performance
- Use vectorized NumPy/Pandas ops instead of Python loops — 10-100× faster
- For DataFrames > 1M rows: consider `polars` (faster), `dask` (parallel), or chunked reading
- `df.memory_usage(deep=True)` to check memory; downcast types with `pd.to_numeric(downcast='integer')`
- Profile with `%timeit` in Jupyter or `cProfile` in scripts

### Tool Guidance
```bash
jupyter lab                              # start notebook server
pip install pandas numpy matplotlib seaborn scikit-learn
pip install xgboost lightgbm optuna     # advanced ML
pip install polars                       # fast alternative to pandas
```

### Pitfalls
- **Data leakage**: fitting the scaler (or any preprocessor) on the full dataset before splitting — always fit on train only
- Evaluating on the training set — always hold out a test set the model never sees
- Ignoring class imbalance — use `class_weight='balanced'` or SMOTE
- `inplace=True` on chained operations — use assignment instead for clarity
- `SettingWithCopyWarning` — use `.loc[]` for setting values, not chained indexing
