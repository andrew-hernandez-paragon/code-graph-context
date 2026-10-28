export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProjectNotFoundError extends ProjectError {}

export class AmbiguousProjectError extends ProjectError {}

export class NotACodebaseError extends ProjectError {}

export class InvalidProjectInputError extends ProjectError {}
