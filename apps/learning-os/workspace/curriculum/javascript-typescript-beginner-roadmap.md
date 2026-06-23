# JavaScript & TypeScript Learning Roadmap

**Goal:** Build beginner-intermediate proficiency in JavaScript and TypeScript to read, understand, and debug code effectively

**Level:** Experienced programmer (Python) new to JavaScript/TypeScript

**Timeline:** 6 weeks

**Study time/week:** 5-7 hours

---

## Module 1: JavaScript Fundamentals - The Python Differences

**Duration:** 0.5 weeks (2-3 hours)

**Resources:**

- [MDN: JavaScript Guide - Introduction](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Introduction) — Quick overview
- [JavaScript.info: Variables](https://javascript.info/variables) — let, const, var (the differences matter)
- [MDN: Data Types](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures) — Compare to Python types

**Focus Areas (Python != JavaScript):**

- `let`/`const` vs Python's mutability model (const isn't truly immutable)
- JavaScript's type coercion (1 + "1" = "11", not error)
- `undefined` vs `null` — why both exist
- Python's `elif` vs JavaScript's `else if`
- Falsy values: `0`, `""`, `null`, `undefined`, `NaN`, `false`

**Exercises:**

- Write code that demonstrates JavaScript type coercion quirks
- Test falsy values in conditionals
- Compare how Python and JS handle variable reassignment

**Milestone:** You understand JavaScript's unique behaviors that trip up developers coming from Python

---

## Module 2: Functions - JavaScript's Multiple Paradigms

**Duration:** 1 week

**Resources:**

- [MDN: Functions](https://developer.mozilla.org/en-US/docs/Learn/JavaScript/Building_blocks/Functions) — All function types
- [MDN: Arrow Functions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/Arrow_functions) — Critical for modern JS
- [JavaScript.info: Arrow Functions](https://javascript.info/arrow-functions-basics) — Deep dive

**Key Differences from Python:**

- Function declarations vs expressions (hoisting differences)
- Arrow functions and the `this` binding (big difference from Python!)
- Default parameters work differently
- Rest parameters (`...args`) vs `*args`
- Python's decorators ≈ JavaScript's higher-order functions

**Exercises:**

- Convert Python functions to arrow functions
- Understand why `this` behaves differently in arrow vs regular functions
- Write a higher-order function that takes a callback (like Python's map/filter with lambdas)
- Practice: Reimplement Python's `map()`, `filter()`, `reduce()` using arrow functions

**Milestone:** You can read and write all function styles, understand `this` binding, and use callbacks

---

## Module 3: Arrays and Functional Methods

**Duration:** 1 week

**Resources:**

- [MDN: Array Methods](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array) — Complete reference
- [JavaScript.info: Array Methods](https://javascript.info/array-methods) — Practical examples

**Focus Areas:**

- `map()` — Python's `map()` but returns a new array
- `filter()` — Python's list comprehension equivalent
- `reduce()` — Python's `functools.reduce` (more commonly used in JS)
- `find()` / `findIndex()` — No direct Python equivalent
- `some()` / `every()` — Check conditions on arrays
- Method chaining (very common in JS)

**Python Comparison:**

```python
# Python
result = [x * 2 for x in numbers if x > 0]

# JavaScript
const result = numbers.filter(x => x > 0).map(x => x * 2);
```

**Exercises:**

- Given an array of user objects, filter by age, map to names, reduce to count
- Chain 3+ array methods together
- Practice: Recreate Python's pandas-like groupBy using reduce
- Compare: Write the same logic in Python and JavaScript

**Milestone:** You can fluently use array methods and chain them — you'll see this constantly in real code

---

## Module 4: Objects and Prototypes (The JavaScript OOP Model)

**Duration:** 1 week

**Resources:**

- [MDN: Objects](https://developer.mozilla.org/en-US/docs/Learn/JavaScript/Objects/Basics) — Creating and using objects
- [MDN: prototype](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/prototype) — Understanding the prototype chain
- [JavaScript.info: Prototypes](https://javascript.info/prototypes) — How JS inheritance actually works

**Key Concepts:**

- Objects as dictionaries (similar to Python dicts)
- Methods in objects — the `this` keyword
- Destructuring (similar to Python's unpacking but more flexible)
- Object spread (`{...obj}`) — Python's `{**dict}` equivalent
- Prototype inheritance vs Python's class inheritance
- `class` syntax (ES6) — more familiar for Python devs

**Python Comparison:**

```python
# Python
class Person:
    def __init__(self, name):
        self.name = name
    
    def greet(self):
        return f"Hello, {self.name}"

# JavaScript (ES6 class)
class Person {
    constructor(name) {
        this.name = name;
    }
    greet() {
        return `Hello, ${this.name}`;
    }
}
```

**Exercises:**

- Create a class hierarchy (inheritance) in JavaScript
- Use object destructuring to extract values
- Convert a plain object to a class-based structure
- Practice: Build a simple "inventory" system with classes

**Milestone:** You understand JavaScript's object model, can read class syntax, and understand prototypes

---

## Module 5: Modern JavaScript (ES6+) & Async Patterns

**Duration:** 1 week

**Resources:**

- [MDN: ES6 New Features](https://www.freecodecamp.org/news/es6-tutorial/) — Comprehensive ES6 guide
- [JavaScript.info: Promises](https://javascript.info/promise-basics) — Understanding async JavaScript
- [MDN: Async/Await](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function) — Modern async syntax

**Key Features:**

- Template literals (f-strings in Python)
- Destructuring arrays and objects
- Spread operator (`...`) — very common
- Optional chaining (`?.`) and nullish coalescing (`??`)
- Modules: `import`/`export` (Python's `from x import y`)
- Promises (Python's asyncio concepts)
- Async/await (similar to Python's async/await)

**Exercises:**

- Refactor old callback code to use Promises
- Write async functions that await multiple promises
- Use optional chaining to safely access nested properties
- Practice: Fetch data from a public API using fetch() + async/await
- Convert synchronous code to async

**Milestone:** You can read modern async JavaScript code and understand import/export modules

---

## Module 6: TypeScript Fundamentals

**Duration:** 1.5 weeks

**Resources:**

- [TypeScript Official Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) — Definitive guide
- [TypeScript for JavaScript Programmers](https://www.typescriptlang.org/docs/handbook/2/basic-types.html) — Quick overview
- [TypeScript Deep Dive](https://basarat.gitbook.io/typescript/) — Comprehensive resource

**Key Concepts:**

- Type annotations vs Python type hints (but enforced at compile time!)
- Primitive types: `string`, `number`, `boolean`
- Arrays: `number[]` vs Python's `List[int]`
- Objects as types vs Python's TypedDict or dataclasses
- Interfaces vs Python's Protocol or ABC
- Generics (similar to Python's generics)
- `any`, `unknown`, `void`, `never` types
- Type inference (TS infers types like Python sometimes does)

**Python Comparison:**

```python
# Python with type hints
def greet(name: str) -> str:
    return f"Hello, {name}"

// TypeScript
function greet(name: string): string {
    return `Hello, ${name}`;
}
```

**Exercises:**

- Install TypeScript: `npm install -g typescript`
- Write a .ts file and compile it: `tsc file.ts`
- Add type annotations to an existing JS function
- Create interfaces for data structures (User, Product, etc.)
- Write a generic function (compare to Python's TypeVar)
- Practice: Convert a JavaScript file to TypeScript and fix all type errors

**Milestone:** You can read TypeScript code, understand type annotations, interfaces, and generics

---

## Milestones Overview

| Week | Milestone |
|------|----------|
| 1 | Understand JS quirks (type coercion, falsy values, let/const) |
| 2 | Write all function types, understand `this` and callbacks |
| 3 | Use array methods fluently (map, filter, reduce) |
| 4 | Work with objects, classes, and prototypes |
| 5 | Read/write modern ES6+, understand async/await |
| 6 | Read TypeScript, use types, interfaces, generics |

---

## Recommended Exercises for Ongoing Practice

**1. Exercism JavaScript Track**

- [Exercism: JavaScript](https://exercism.org/tracks/javascript) — Mentored exercises, good for deepening understanding

**2. TypeScript Exercises**

- [TypeScript Exercises](https://typescript-exercises.github.io/) — Practice TypeScript directly

**3. Codewars (JavaScript)**

- [Codewars: JavaScript](https://www.codewars.com/?language=javascript) — Katas to practice JS patterns

**4. Real Projects**

- After Week 3: Build a CLI tool that processes data using array methods
- After Week 5: Fetch data from an API and display it
- After Week 6: Convert a small Python script to TypeScript

---

## How to Debug JavaScript/TypeScript

**Essential Debugging Tools:**

1. **Console.log()** — Basic but effective (Python's print)
2. **Browser DevTools** — Console, Network tab for API calls
3. **VS Code Debugger** — Set breakpoints, step through code
4. **node --inspect** — Debug Node.js code in Chrome
5. **TypeScript compiler errors** — Read them carefully, they're helpful

**Practice approach:**

- Since you know Python, compare JS error messages to Python tracebacks
- TypeScript catches many errors at compile time (like mypy)
- Browser DevTools Console is like Python's REPL but more powerful

---

## Key Differences to Keep in Mind

| Python | JavaScript |
|--------|------------|
| `elif` | `else if` |
| `None` | `null` or `undefined` |
| List comprehensions | Array methods (`.map()`, `.filter()`) |
| Decorators | Higher-order functions |
| `*args` | Rest parameters (`...args`) |
| `**kwargs` | Spread operator (`{...obj}`) |
| Type hints (optional) | TypeScript (enforced) |
| `async/await` | `async/await` (similar!) |
| Classes (OOP only) | Objects, Prototypes, Classes (multiple paradigms) |

---

## Tips for Success

1. **Lean into what you know** — Python experience gives you programming logic; focus on JS-specific patterns
2. **Embrace array methods** — These are used everywhere in JS (unlike Python where list comprehensions dominate)
3. **Understand `this`** — The biggest "gotcha" for Python devs
4. **TypeScript first** — Since you have type hint experience, TypeScript will feel natural
5. **Read real code** — Once you have the basics, read open-source JS/TS code on GitHub

---

## Prerequisite Knowledge Check

This roadmap assumes:

- Comfortable with programming concepts (loops, conditionals, functions, OOP)
- Familiar with Python's type hints
- Can use terminal/command line
- Have Node.js, npm, npx installed
- Know how to use a code editor (VS Code)

You're ready to start!