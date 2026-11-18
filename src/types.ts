export interface TodoList {
  id: string;
  displayName: string;
  wellknownListName?: string;
}

export interface TodoTask {
  id: string;
  title: string;
  status: "notStarted" | "inProgress" | "completed" | "autoCompleted";
  importance: "low" | "normal" | "high";
  isReminderOn?: boolean;
  dueDateTime?: { dateTime: string; timeZone: string };
  completedDateTime?: { dateTime: string; timeZone: string };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  body?: { content: string; contentType: string };
  linkedNote?: string;
}

export interface GraphTaskResponse {
  value: TodoTask[];
  "@odata.nextLink"?: string;
}

export interface GraphListResponse {
  value: TodoList[];
  "@odata.nextLink"?: string;
}
