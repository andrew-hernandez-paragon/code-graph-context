# Contributing to Code Graph Context

Guidelines for contributing to this project.

## Ways to Contribute

- **Bug Reports**: Open an issue with details and reproduction steps
- **Feature Requests**: Create an issue describing your proposed feature
- **Code Contributions**: Submit pull requests for bug fixes or new features
- **Documentation**: Improve docs, examples, or tutorials
- **Framework Schemas**: Share custom framework schemas

## Development Setup

### Prerequisites

- Node.js >= 18
- Docker (for Neo4j)
- Git
- OpenAI API key

### Setup Steps

1. **Fork and clone**
```bash
git clone https://github.com/drew-paragon/code-graph-context.git
cd code-graph-context
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment**
```bash
cp .env.example .env
# Edit .env with your OpenAI API key
```

4. **Start Neo4j**
```bash
docker-compose up -d
```

5. **Build**
```bash
npm run build
```

6. **Test**
```bash
npm run mcp
npm run lint
npm run format
```

## Code Standards

### TypeScript

- Use TypeScript for all code
- Follow existing style (ESLint/Prettier enforced)
- Use explicit types
- Add JSDoc comments for public APIs

### Example

```typescript
/**
 * Parse a TypeScript project and build a code graph
 * @param projectPath - Absolute path to project root
 * @param tsconfigPath - Path to tsconfig.json
 * @returns Parsed nodes and edges
 */
export async function parseProject(
  projectPath: string,
  tsconfigPath: string
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  // Implementation
}
```

## Commit Messages

Use Conventional Commits format:

```
type(scope): description
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Formatting
- `refactor`: Code restructuring
- `perf`: Performance improvement
- `test`: Tests
- `chore`: Maintenance

**Examples:**
```bash
feat(parser): add decorator argument support
fix(neo4j): resolve connection timeout
docs(readme): add troubleshooting section
refactor(traversal): simplify relationship detection
```

## Pull Request Process

1. **Create feature branch**
```bash
git checkout -b feat/your-feature-name
```

2. **Make changes and test**
```bash
npm run build
npm run lint
npm run format
```

3. **Commit**
```bash
git add .
git commit -m "feat(scope): description"
```

4. **Push and create PR**
```bash
git push origin feat/your-feature-name
```

### PR Description Template

```markdown
## Description
Brief summary of changes

## Changes
- Item 1
- Item 2

## Testing
How to test the changes

## Related Issues
Closes #123
```

## Testing

No automated tests currently. Manual testing checklist:

- [ ] Code builds (`npm run build`)
- [ ] Linting passes (`npm run lint`)
- [ ] MCP server starts
- [ ] Can parse TypeScript project
- [ ] Neo4j receives data
- [ ] Tools work correctly

## Bug Reports

Include:
- Clear title
- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, Node version, package version)
- Error messages
- Screenshots if applicable

## Feature Requests

Include:
- Problem statement
- Proposed solution
- Use cases
- Alternatives considered

## Priority Areas

- Testing infrastructure
- Additional framework schemas (React, Angular, Vue)
- Performance optimizations
- Multi-language support (Python, Java, C#)
- CI/CD pipelines

## License

Contributions are licensed under MIT License.
