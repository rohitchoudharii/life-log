# Eigenvectors and eigenvalues

A square matrix A transforms vectors. Most vectors change direction when multiplied by A, but some only get stretched or shrunk. A nonzero vector v with Av = λv is an eigenvector of A, and the number λ is its eigenvalue. If λ is negative the vector flips; if λ is zero, A squashes that direction to nothing, so A is not invertible.

## Finding eigenvalues

Av = λv can be rewritten as (A − λI)v = 0. A nonzero solution v exists only when A − λI is singular, that is when det(A − λI) = 0. This is the characteristic equation; for a 2×2 matrix it is a quadratic in λ. For A = [[a, b], [c, d]] it is λ² − (a + d)λ + (ad − bc) = 0, so the eigenvalues add up to the trace a + d and multiply to the determinant ad − bc. Once λ is known, the eigenvectors are the nonzero solutions of (A − λI)v = 0.

## Why they matter

If A has n independent eigenvectors, writing a vector in that basis turns A into a diagonal matrix: each coordinate is simply multiplied by its eigenvalue. Repeated multiplication becomes easy: Aᵏ multiplies each coordinate by λᵏ. Components with |λ| > 1 grow, those with |λ| < 1 die out, so for large k the direction with the largest |λ| dominates. This is why power iteration finds the dominant eigenvector, and why the eigenvalues of a system's matrix decide whether it is stable.

Not every matrix has enough eigenvectors. A shear such as [[1, 1], [0, 1]] has the single eigenvalue 1 but only one independent eigenvector, so it cannot be diagonalised.
