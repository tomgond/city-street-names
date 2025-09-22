import { defineConfig } from "vite"

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? ""

export default defineConfig({
    base: repositoryName ? `/${repositoryName}/` : "/",
    preview: {
        allowedHosts: true
    }
})
