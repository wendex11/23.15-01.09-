const ALLOWED_ITEMS = [
  "Кофе",
  "Помидор",
  "Молоко",
  "Гипс",
  "Железо",
  "Реагенты",
  "Аммиак",
  "Остатки приборов шепота",
  "Отличная тушенка",
  "Газовый баллон",
  "Перчатки",
  "Чеснок",
  "Поташ",
  "Мясо шавки",
  "Мясо кабана",
  "Мясо хрюши"
];

/* =========================
   JSON HELPERS
========================= */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function errorResponse(message, status = 500, details = null) {
  const result = {
    error: message
  };

  if (details) {
    result.details = String(details);
  }

  return jsonResponse(result, status);
}

/* =========================
   OPENAI RESPONSE PARSER
========================= */

function extractOutputText(result) {
  if (
    result &&
    typeof result.output_text === "string" &&
    result.output_text.trim()
  ) {
    return result.output_text.trim();
  }

  if (!Array.isArray(result?.output)) {
    return "";
  }

  for (const outputItem of result.output) {
    if (!Array.isArray(outputItem?.content)) {
      continue;
    }

    for (const contentItem of outputItem.content) {
      if (
        contentItem?.type === "output_text" &&
        typeof contentItem.text === "string" &&
        contentItem.text.trim()
      ) {
        return contentItem.text.trim();
      }
    }
  }

  return "";
}

/* =========================
   RECOGNITION CLEANUP
========================= */

function cleanRecognition(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  const merged = new Map();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const name = String(item.name || "").trim();

    if (!ALLOWED_ITEMS.includes(name)) {
      continue;
    }

    let quantity = Number(item.quantity);

    if (!Number.isFinite(quantity)) {
      continue;
    }

    quantity = Math.max(
      0,
      Math.floor(quantity)
    );

    if (quantity === 0) {
      continue;
    }

    let confidence = Number(item.confidence);

    if (!Number.isFinite(confidence)) {
      confidence = 0;
    }

    confidence = Math.max(
      0,
      Math.min(1, confidence)
    );

    if (!merged.has(name)) {
      merged.set(name, {
        name,
        quantity: 0,
        confidence: 0
      });
    }

    const current = merged.get(name);

    current.quantity += quantity;

    current.confidence = Math.max(
      current.confidence,
      confidence
    );
  }

  return Array.from(merged.values());
}

/* =========================
   AI RECOGNITION
========================= */

async function recognizeImage(request, env) {

  /*
    ВАЖНАЯ ДИАГНОСТИКА

    Не выводим значение ключа.
    Проверяем только наличие.
  */

  console.log(
    "ENV KEYS:",
    Object.keys(env || {})
  );

  if (!env?.OPENAI_API_KEY) {
    return errorResponse(
      "OPENAI_API_KEY не настроен в Cloudflare.",
      500
    );
  }

  /* =========================
     READ REQUEST
  ========================= */

  let body;

  try {
    body = await request.json();
  } catch {
    return errorResponse(
      "Сервер получил некорректный JSON.",
      400
    );
  }

  const imageDataUrl = body?.image;

  if (
    typeof imageDataUrl !== "string" ||
    !imageDataUrl.startsWith("data:image/")
  ) {
    return errorResponse(
      "Изображение не передано или имеет неверный формат.",
      400
    );
  }

  /* =========================
     AI PROMPT
  ========================= */

  const prompt = `
Ты распознаёшь предметы на скриншоте инвентаря игры.

РАЗРЕШЁННЫЕ ПРЕДМЕТЫ:

${ALLOWED_ITEMS.map(
  item => "- " + item
).join("\n")}

ПРАВИЛА:

1. Найди все предметы из разрешённого списка.
2. Для каждого предмета определи количество.
3. Если один предмет встречается несколько раз, объедини количество.
4. Не добавляй предметы вне разрешённого списка.
5. Игнорируй неизвестные предметы.
6. Не считай стоимость.
7. Не добавляй пояснения.
8. Верни только JSON по указанной схеме.
9. Если количество невозможно определить, не добавляй предмет.
10. Будь особенно внимателен к маленьким цифрам количества.
`;

  /* =========================
     OPENAI REQUEST
  ========================= */

  const openaiPayload = {
    model: "gpt-5",

    input: [
      {
        role: "user",

        content: [
          {
            type: "input_text",
            text: prompt
          },

          {
            type: "input_image",
            image_url: imageDataUrl,
            detail: "high"
          }
        ]
      }
    ],

    text: {
      format: {
        type: "json_schema",

        name: "inventory_recognition",

        strict: true,

        schema: {
          type: "object",

          additionalProperties: false,

          properties: {
            items: {
              type: "array",

              items: {
                type: "object",

                additionalProperties: false,

                properties: {
                  name: {
                    type: "string",
                    enum: ALLOWED_ITEMS
                  },

                  quantity: {
                    type: "integer",
                    minimum: 0
                  },

                  confidence: {
                    type: "number",
                    minimum: 0,
                    maximum: 1
                  }
                },

                required: [
                  "name",
                  "quantity",
                  "confidence"
                ]
              }
            }
          },

          required: [
            "items"
          ]
        }
      }
    }
  };

  let openaiResponse;

  try {
    openaiResponse = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Authorization":
            `Bearer ${env.OPENAI_API_KEY}`
        },

        body: JSON.stringify(
          openaiPayload
        )
      }
    );
  } catch (networkError) {

    console.error(
      "OpenAI network error:",
      networkError
    );

    return errorResponse(
      "Не удалось связаться с OpenAI API.",
      502,
      networkError?.message
    );
  }

  /* =========================
     READ OPENAI RESPONSE
  ========================= */

  const rawText =
    await openaiResponse.text();

  if (!openaiResponse.ok) {

    console.error(
      "OpenAI HTTP error:",
      openaiResponse.status,
      rawText
    );

    let details = rawText;

    try {
      const parsed =
        JSON.parse(rawText);

      details =
        parsed?.error?.message ||
        parsed?.error?.type ||
        rawText;

    } catch {
      // Оставляем исходный ответ.
    }

    return errorResponse(
      "OpenAI API вернул ошибку.",
      openaiResponse.status,
      details
    );
  }

  if (!rawText.trim()) {

    return errorResponse(
      "OpenAI API вернул пустой ответ.",
      502
    );
  }

  /* =========================
     PARSE OPENAI JSON
  ========================= */

  let result;

  try {
    result =
      JSON.parse(rawText);
  } catch {

    console.error(
      "Invalid OpenAI JSON:",
      rawText.slice(0, 1000)
    );

    return errorResponse(
      "OpenAI API вернул некорректный JSON.",
      502,
      rawText.slice(0, 500)
    );
  }

  /* =========================
     GET MODEL TEXT
  ========================= */

  const outputText =
    extractOutputText(result);

  if (!outputText) {

    console.error(
      "OpenAI output_text is empty:",
      rawText.slice(0, 1000)
    );

    return errorResponse(
      "OpenAI не вернул результат распознавания.",
      502
    );
  }

  /* =========================
     PARSE MODEL JSON
  ========================= */

  let parsedOutput;

  try {
    parsedOutput =
      JSON.parse(outputText);
  } catch {

    console.error(
      "Invalid model JSON:",
      outputText
    );

    return errorResponse(
      "Результат распознавания оказался некорректным JSON.",
      502,
      outputText.slice(0, 500)
    );
  }

  /* =========================
     CLEAN RESULT
  ========================= */

  const items =
    cleanRecognition(
      parsedOutput?.items
    );

  return jsonResponse({
    items
  });
}

/* =========================
   WORKER
========================= */

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);

    /* =========================
       TEST SECRET
    ========================= */

    if (
      url.pathname === "/api/test-key" &&
      request.method === "GET"
    ) {

      console.log(
        "TEST ENV KEYS:",
        Object.keys(env || {})
      );

      return jsonResponse({
        OPENAI_API_KEY:
          env?.OPENAI_API_KEY
            ? "НАЙДЕН"
            : "НЕ НАЙДЕН"
      });
    }

    /* =========================
       AI API
    ========================= */

    if (
      url.pathname === "/api/recognize" &&
      request.method === "POST"
    ) {

      return recognizeImage(
        request,
        env
      );
    }

    /* =========================
       WRONG METHOD
    ========================= */

    if (
      url.pathname === "/api/recognize"
    ) {

      return jsonResponse(
        {
          error:
            "Используй POST /api/recognize"
        },
        405
      );
    }

    /* =========================
       STATIC FILES
    ========================= */

    if (env?.ASSETS) {

      return env.ASSETS.fetch(
        request
      );
    }

    return new Response(
      "ASSETS binding не настроен.",
      {
        status: 500,

        headers: {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }
};
