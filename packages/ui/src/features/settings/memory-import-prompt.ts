/** What Settings › Memory › Start import asks the person to paste into their other assistant (the Memory page of the docs). */
export const MEMORY_IMPORT_PROMPT = `I'm moving to another assistant and want to take what you know about me along. Export everything you have stored or learned about me: your saved memories and any context you've picked up from our conversations. Copy entries word for word where you can, and don't summarize, merge or leave anything out.

Sort the entries into these sections, in this order, and skip a section only if you have nothing for it:

1. Instructions: rules I've explicitly asked you to follow about tone, format, style, length or language, things to always or never do, and corrections I've made to how you respond. Only take these from your stored memories, not from guesses about my habits.
2. Identity: my name, age, where I live, education, family and relationships, and languages I speak.
3. Career: my roles, the companies I've worked for, and my skills.
4. Interests: my hobbies and interests, each with everything you know about it (gear, plans, purchases, progress).
5. People: the people in my life, one entry per fact, each starting with the person's name.
6. Projects: one entry per fact about the projects I've told you about, each starting with the project's name: what it is, where it stands, and the decisions made so far.
7. Preferences: my opinions and tastes, and how I like to work.

Format: put each section under its own Markdown header, such as "## Identity". Write one entry per line, oldest first, as:
[YYYY-MM-DD] - Entry
Use [unknown] in place of the date when you don't know when you learned it.

Put the whole export inside a single code block so I can copy it in one go. After the code block, tell me whether this is everything you have about me or whether some of it couldn't be included.`;
