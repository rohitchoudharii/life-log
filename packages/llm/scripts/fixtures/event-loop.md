# The JavaScript event loop

JavaScript runs your code on a single thread with one call stack. A function call pushes a frame; returning pops it. While the stack is busy, nothing else in your code can run, so a long loop freezes the page.

## Tasks and microtasks

Work that should happen later waits in queues. Timers, I/O callbacks, and UI events are tasks. Promise reactions (then, catch, finally, and the code after an await) are microtasks. The event loop repeats one rule: when the stack is empty, take one task and run it to completion, then run every microtask in the queue, including microtasks added while draining it, and only then move on (rendering may happen here in browsers).

So in this code:

```js
console.log('a')
setTimeout(() => console.log('b'), 0)
Promise.resolve().then(() => console.log('c'))
console.log('d')
```

the output is a, d, c, b. The synchronous lines run first, the promise reaction is a microtask that runs as soon as the stack empties, and the timer is a task that waits for the next turn of the loop even with a 0 ms delay.

## Consequences

Because all microtasks drain before the next task, a promise chain that keeps scheduling more microtasks can starve timers and rendering just as a busy loop does. And await does not block the thread: it suspends the async function, returns control to the caller, and resumes the function later as a microtask. Splitting heavy work into chunks with setTimeout lets rendering and input happen in between.
