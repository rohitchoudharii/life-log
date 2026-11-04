# Why attention replaced recurrence

Recurrent networks read a sentence one token at a time and carry everything they have seen in a single hidden state. Two problems follow. Training cannot be parallelised across the tokens of a sentence, because step five needs the result of step four. And information from early tokens has to survive many updates of the hidden state, so long-range dependencies fade. Attention removes both problems: every token can look directly at every other token in one step, and all tokens are processed at the same time.

## Queries, keys, and values

Each token is turned into three vectors by three learned matrices: a query, a key, and a value. The query says what the token is looking for, the key says what it offers, and the value is what it hands over if chosen. The score between two tokens is the dot product of one token's query with the other's key. A high score means the second token is relevant to the first.

The scores for one token are divided by the square root of the key dimension before softmax. Without this, dot products grow with the dimension, softmax pushes almost all weight onto one token, and its gradients become tiny, which slows learning.

## Softmax and the weighted sum

Softmax turns a token's scores into weights that are positive and add up to one. The token's output is the weighted sum of all value vectors. Because softmax exaggerates differences, a score that is larger by 2 gives a weight roughly e² ≈ 7.4 times larger.

## Multiple heads

A single attention head can only form one weighting per token. Multi-head attention runs several smaller heads in parallel, each with its own query, key, and value matrices in a lower-dimensional subspace. One head might track which noun a pronoun refers to while another tracks the verb's object. Their outputs are concatenated and projected back to the model dimension, so the total cost is similar to one full-size head.

## Positional information

Attention by itself treats its input as a set: shuffling the tokens shuffles the outputs the same way, and nothing tells the model which token came first. Transformers therefore add a positional signal to each token's embedding, either fixed sine and cosine patterns of different frequencies or learned position vectors. Without it, "dog bites man" and "man bites dog" would look identical.
