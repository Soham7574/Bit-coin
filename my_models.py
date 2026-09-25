"""
Machine-learning models implemented from scratch with pure NumPy (no ML libraries).

MyLinearRegression   - predicts a number (next-day log return)     -> loss: Mean Squared Error
MyLogisticRegression - predicts a class  (next day up = 1, down = 0) -> loss: Binary Cross-Entropy

Both are trained with batch gradient descent:
    1. initialise weights w = 0 and bias b = 0
    2. forward pass   : z = X @ w + b
    3. compute loss
    4. compute gradients dL/dw, dL/db
    5. update         : w -= lr * dL/dw,  b -= lr * dL/db
    6. repeat for N epochs (stop early if the loss stops improving)
"""
import numpy as np


class MyLinearRegression:
    """Linear regression y_hat = X @ w + b trained by gradient descent on MSE."""

    def __init__(self, learning_rate=0.05, n_epochs=20000, tol=1e-12):
        self.learning_rate = learning_rate
        self.n_epochs = n_epochs
        self.tol = tol  # stop when the loss improves by less than this

    def fit(self, X, y):
        X = np.asarray(X, dtype=float)
        y = np.asarray(y, dtype=float)
        m, n = X.shape
        # Step 1: weight initialisation
        self.w = np.zeros(n)
        self.b = 0.0
        self.loss_history = []
        for epoch in range(self.n_epochs):
            # Step 2: forward pass
            y_hat = X @ self.w + self.b
            error = y_hat - y
            # Step 3: Mean Squared Error loss  L = (1/m) * sum((y_hat - y)^2)
            loss = np.mean(error ** 2)
            self.loss_history.append(loss)
            # Step 4: gradients  dL/dw = (2/m) X^T (y_hat - y),  dL/db = (2/m) sum(y_hat - y)
            grad_w = (2 / m) * (X.T @ error)
            grad_b = (2 / m) * np.sum(error)
            # Step 5: gradient-descent update
            self.w -= self.learning_rate * grad_w
            self.b -= self.learning_rate * grad_b
            # Step 6: early stopping
            if epoch > 0 and abs(self.loss_history[-2] - loss) < self.tol:
                break
        self.n_epochs_run = epoch + 1
        return self

    def predict(self, X):
        return np.asarray(X, dtype=float) @ self.w + self.b


class MyLogisticRegression:
    """Logistic regression P(y=1|X) = sigmoid(X @ w + b) trained by gradient descent on
    binary cross-entropy. `class_weight='balanced'` re-weights rows so both classes count equally."""

    def __init__(self, learning_rate=0.1, n_epochs=5000, tol=1e-10, class_weight=None, threshold=0.5):
        self.learning_rate = learning_rate
        self.n_epochs = n_epochs
        self.tol = tol
        self.class_weight = class_weight
        self.threshold = threshold

    @staticmethod
    def sigmoid(z):
        # Step 2: sigmoid activation, clipped for numerical stability
        return 1.0 / (1.0 + np.exp(-np.clip(z, -500, 500)))

    def fit(self, X, y):
        X = np.asarray(X, dtype=float)
        y = np.asarray(y, dtype=float)
        m, n = X.shape
        # Sample weights (same formula as scikit-learn: n_samples / (n_classes * n_class_samples))
        if self.class_weight == "balanced":
            pos = y.mean()
            sw = np.where(y == 1, 1 / (2 * pos), 1 / (2 * (1 - pos)))
        else:
            sw = np.ones(m)
        # Step 1: weight initialisation
        self.w = np.zeros(n)
        self.b = 0.0
        self.loss_history = []
        eps = 1e-12
        for epoch in range(self.n_epochs):
            # Step 3: probability prediction for all m rows
            p = self.sigmoid(X @ self.w + self.b)
            # Step 4: binary cross-entropy  L = -(1/m) * sum(y log p + (1-y) log(1-p))
            loss = -np.mean(sw * (y * np.log(p + eps) + (1 - y) * np.log(1 - p + eps)))
            self.loss_history.append(loss)
            # Step 5: gradients  dL/dw = (1/m) X^T (p - y),  dL/db = (1/m) sum(p - y)
            error = sw * (p - y)
            grad_w = (1 / m) * (X.T @ error)
            grad_b = (1 / m) * np.sum(error)
            self.w -= self.learning_rate * grad_w
            self.b -= self.learning_rate * grad_b
            if epoch > 0 and abs(self.loss_history[-2] - loss) < self.tol:
                break
        self.n_epochs_run = epoch + 1
        return self

    def predict_proba(self, X):
        return self.sigmoid(np.asarray(X, dtype=float) @ self.w + self.b)

    def predict(self, X):
        # Step 6: probability >= threshold -> class 1 (price goes up)
        return (self.predict_proba(X) >= self.threshold).astype(int)
