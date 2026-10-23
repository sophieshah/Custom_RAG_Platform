export const DEFAULT_INPUT_CONFIG = {
  version: 1,
  tabs: [
    {
      id: "narrative",
      title: "Patient Narrative",
      description: "Add optional details for the LLM to consider as context.",
      fields: [
        {
          id: "patientNarrative",
          label: "Patient details",
          type: "textarea",
          placeholder: "Describe relevant history, symptoms, or other context.",
        },
      ],
    },
    {
      id: "labs",
      title: "Labs",
      fields: [
        {
          id: "bacterialBurden",
          label: "Pre-treatment bacterial burden",
          type: "select",
          options: ["Low", "Moderate", "High", "Unknown"],
        },
        {
          id: "geneXpert",
          label: "GeneXpert and drug susceptibility",
          type: "select",
          options: [
            "Positive (rifampin resistant)",
            "Positive (rifampin susceptible—no resistance detected)",
            "Negative",
            "Pending or not available",
          ],
        },
      ],
    },
    {
      id: "community",
      title: "Community Risk",
      description: "Selections are user-provided context, not an automated assessment.",
      fields: [
        {
          id: "communityRisk",
          label: "Community risk",
          type: "select",
          options: ["Low", "Medium", "High", "Unknown"],
        },
      ],
    },
    {
      id: "patientHarm",
      title: "Patient Harm",
      fields: [
        {
          id: "patientHarm",
          label: "Patient harm or impact",
          type: "select",
          options: ["Low", "Medium", "High", "Unknown"],
        },
      ],
    },
    {
      id: "treatment",
      title: "Treatment",
      fields: [
        {
          id: "treatmentDays",
          label: "Days on treatment",
          type: "number",
          placeholder: "Not provided",
        },
        {
          id: "treatmentDrugs",
          label: "Treatment drugs or regimen",
          type: "textarea",
          placeholder: "Enter any known treatment details.",
        },
        {
          id: "treatmentTolerance",
          label: "Treatment tolerance or adherence details",
          type: "textarea",
          placeholder: "Enter any relevant details.",
        },
        {
          id: "drugResistance",
          label: "Concern for drug resistance",
          type: "select",
          options: ["Yes", "No", "Unknown"],
        },
      ],
    },
  ],
};

const FIELD_TYPES = new Set(["text", "textarea", "number", "select", "checkbox"]);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function assertAllowedKeys(value, allowedKeys, location) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${location} contains unsupported property "${key}".`);
    }
  }
}

export function validateInputConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Input configuration must be a JSON object.");
  }
  assertAllowedKeys(value, ["version", "tabs"], "Input configuration");
  if (value.version !== 1) throw new Error("Input configuration version must be 1.");
  if (!Array.isArray(value.tabs) || value.tabs.length > 12) {
    throw new Error("Input configuration must contain at most 12 tabs.");
  }

  const tabIds = new Set();
  const fieldIds = new Set();
  const tabs = value.tabs.map((tab, tabIndex) => {
    const tabLocation = `Tab ${tabIndex + 1}`;
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) {
      throw new Error(`${tabLocation} must be an object.`);
    }
    assertAllowedKeys(tab, ["id", "title", "description", "fields"], tabLocation);
    if (typeof tab.id !== "string" || !ID_PATTERN.test(tab.id)) {
      throw new Error(`${tabLocation} id must start with a letter and contain only letters, numbers, underscores, or hyphens.`);
    }
    if (tab.id === "__guidance_chat") {
      throw new Error(`${tabLocation} id is reserved for the guidance chat.`);
    }
    if (tabIds.has(tab.id)) throw new Error(`Duplicate tab id "${tab.id}".`);
    tabIds.add(tab.id);
    if (typeof tab.title !== "string" || !tab.title.trim() || tab.title.length > 80) {
      throw new Error(`${tabLocation} title must contain 1 to 80 characters.`);
    }
    if (tab.description !== undefined &&
      (typeof tab.description !== "string" || tab.description.length > 500)) {
      throw new Error(`${tabLocation} description must be text of at most 500 characters.`);
    }
    if (!Array.isArray(tab.fields) || tab.fields.length > 30) {
      throw new Error(`${tabLocation} fields must be an array of at most 30 fields.`);
    }

    const fields = tab.fields.map((field, fieldIndex) => {
      const location = `${tabLocation}, field ${fieldIndex + 1}`;
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        throw new Error(`${location} must be an object.`);
      }
      assertAllowedKeys(
        field,
        ["id", "label", "type", "placeholder", "required", "options"],
        location,
      );
      if (typeof field.id !== "string" || !ID_PATTERN.test(field.id)) {
        throw new Error(`${location} id must start with a letter and contain only letters, numbers, underscores, or hyphens.`);
      }
      if (fieldIds.has(field.id)) throw new Error(`Duplicate field id "${field.id}".`);
      fieldIds.add(field.id);
      if (typeof field.label !== "string" || !field.label.trim() || field.label.length > 120) {
        throw new Error(`${location} label must contain 1 to 120 characters.`);
      }
      if (!FIELD_TYPES.has(field.type)) {
        throw new Error(`${location} type must be text, textarea, number, select, or checkbox.`);
      }
      if (field.placeholder !== undefined &&
        (typeof field.placeholder !== "string" || field.placeholder.length > 300)) {
        throw new Error(`${location} placeholder must be text of at most 300 characters.`);
      }
      if (field.required !== undefined && typeof field.required !== "boolean") {
        throw new Error(`${location} required must be a boolean.`);
      }
      if (field.type === "select") {
        if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 50) {
          throw new Error(`${location} select fields need between 1 and 50 options.`);
        }
        if (field.options.some((option) => (
          typeof option !== "string" || !option.trim() || option.length > 120
        ))) {
          throw new Error(`${location} select options must be non-empty text of at most 120 characters.`);
        }
        if (new Set(field.options).size !== field.options.length) {
          throw new Error(`${location} select options must be unique.`);
        }
      } else if (field.options !== undefined) {
        throw new Error(`${location} options are only valid for select fields.`);
      }

      return {
        id: field.id,
        label: field.label.trim(),
        type: field.type,
        ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
        ...(field.required === undefined ? {} : { required: field.required }),
        ...(field.type === "select" ? { options: [...field.options] } : {}),
      };
    });

    return {
      id: tab.id,
      title: tab.title.trim(),
      ...(tab.description ? { description: tab.description } : {}),
      fields,
    };
  });

  return { version: 1, tabs };
}

export function validateInputValues(values, inputConfig) {
  if (values === undefined) values = {};
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Structured input data must be an object.");
  }

  const fields = inputConfig.tabs.flatMap((tab) => tab.fields);
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  for (const field of fields) {
    if (
      field.required &&
      (field.type === "checkbox"
        ? values[field.id] !== true
        : values[field.id] === undefined || values[field.id] === "")
    ) {
      throw new Error(`Input "${field.label}" is required.`);
    }
  }
  for (const [fieldId, value] of Object.entries(values)) {
    const field = fieldsById.get(fieldId);
    if (!field) throw new Error(`Unknown input field "${fieldId}".`);
    if (field.type === "checkbox") {
      if (typeof value !== "boolean") {
        throw new Error(`Input "${field.label}" must be true or false.`);
      }
      continue;
    }
    if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Input "${field.label}" must be a finite number.`);
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`Input "${field.label}" must be text.`);
    }
    if (value.length > (field.type === "textarea" ? 8000 : 1000)) {
      throw new Error(`Input "${field.label}" is too long.`);
    }
    if (field.type === "select" && value && !field.options.includes(value)) {
      throw new Error(`Input "${field.label}" must match one of its configured options.`);
    }
  }
  if (JSON.stringify(values).length > 32000) {
    throw new Error("Structured input data must be 32,000 characters or fewer.");
  }
}

export function getDefaultInputConfig() {
  return structuredClone(DEFAULT_INPUT_CONFIG);
}
