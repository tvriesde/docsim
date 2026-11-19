I want to create a solution that helps me identify document similarity.

I want to see a dashboard with a canvas that shows clusters of documents with a similar similarity.

And I also want to be able to click a document then see a tree graph network where I can see the similar documents with the convidence score deciding the color of the line between the selected document and the other documents.

the solution should have an ingestion process, where documents can be uploaded in bulk, for each document, there will be a processing step, where metadata is added to the document. this metadata contains an embedding that helps us determine similarity.

ingestion process will do:
-> extract txt from pdf
-> extract document body (remove header and footer) -> do this with a LLM available through foundry
-> generate embedding on the extracted document body

make the frontend look good good, modern SaaS like

use an embedding model from azure. store the application front end in azure static web apps, store the backend in azure container apps.

authentication to be done using entra ad

Create a deployment script that uses azure cli to deploy. use bicep for infra as code. make parts of the deployment skippable to make the script faster.

