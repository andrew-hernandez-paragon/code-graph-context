export interface Neo4jConnection {
  uri: string;
  user: string;
  password: string;
}

export const getNeo4jConnection = (): Neo4jConnection => ({
  uri: process.env.NEO4J_URI ?? 'bolt://localhost:7687',
  user: process.env.NEO4J_USER ?? 'neo4j',
  password: process.env.NEO4J_PASSWORD ?? 'PASSWORD',
});
