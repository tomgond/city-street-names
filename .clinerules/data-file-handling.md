## Brief overview
This guideline is project-specific for the city-street-names repository and provides best practices for handling large files located under the /data directory to avoid performance issues.

## File reading strategy
- Avoid reading files directly under the /data directory due to their large size.
- Instead, use programmatic methods for data processing or read only the first 100 lines to preview file contents.
