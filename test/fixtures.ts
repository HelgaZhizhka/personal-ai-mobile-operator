export const goldenPrompts = [
  {
    prompt: "Что у меня сейчас актуального?",
    expectedTools: ["operator_get_current"],
    allowsWrite: false,
  },
  {
    prompt: "Покажи мой прогресс по активным направлениям.",
    expectedTools: ["operator_get_progress"],
    allowsWrite: false,
  },
  {
    prompt:
      "Пока еду, появилась идея для Personal AI Operator. Запиши ее в проект, но задачу не создавай.",
    expectedTools: ["operator_get_context", "operator_save_update"],
    allowsWrite: true,
  },
  {
    prompt:
      "Добавь задачу: 25 июня написать Тони и уточнить время встречи.",
    expectedTools: ["operator_create_task"],
    allowsWrite: true,
  },
  {
    prompt:
      "Я сейчас наговорю все подряд. Разбери хаос, но ничего пока не записывай.",
    expectedTools: ["operator_get_context"],
    allowsWrite: false,
  },
] as const;
