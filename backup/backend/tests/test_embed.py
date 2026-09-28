

from openai import AzureOpenAI



client = AzureOpenAI(

    api_key="3mKRF119AEpTTbX3Sni9MLimvTEXqxP4ie3Jb5UUhJycDEoSrAJwJQQJ99BDACYeBjFXJ3w3AAABACOGPqpm",

    azure_endpoint="https://aoi-cme-nats-genai-eus.openai.azure.com",

    api_version="2024-12-01-preview",

)



response = client.embeddings.create(

    model="text-embedding-3-large",  # Azure deployment name 

    input="Hello, this is a test embedding."

)



embedding = response.data[0].embedding



print("✅ Embedding generated successfully!")

print(f"Embedding dimensions: {len(embedding)}")

print(f"First 10 values: {embedding[:10]}")

