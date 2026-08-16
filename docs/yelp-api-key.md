# Getting a Yelp Fusion API Key

The `@bot new <location>` command uses the [Yelp Fusion API](https://fusion.yelp.com/) to find real restaurants near you that are similar to places your group already eats at. To enable it, you need a free Yelp Fusion API key.

## Steps

1. **Create or sign in to a Yelp account**
   - Go to [https://www.yelp.com/signup](https://www.yelp.com/signup) if you don't already have one.

2. **Open the Yelp Fusion developer portal**
   - Visit [https://fusion.yelp.com/](https://fusion.yelp.com/).
   - Click **Get Started** or **Manage App**.

3. **Create a new app**
   - Fill in the required fields:
     - **App Name**: something like `Discord Receipt Bot`
     - **Industry**: choose the option that best fits (e.g., `Messaging/Bot` or `Other`)
     - **Contact Email**: your email
     - **Description**: a short sentence like `Discord bot that suggests nearby restaurants based on group receipt history`
   - Agree to the terms and submit.

4. **Copy the API key**
   - Once the app is created, you'll see a section labeled **API Key**.
   - Copy the long string next to it.

5. **Add it to your `.env` file**
   ```env
   YELP_API_KEY=your_yelp_fusion_api_key
   ```

6. **Restart the bot**
   - If you're running in dev mode, stop and restart `bash dev.sh`.
   - In production, redeploy or restart the container.

## Notes

- Yelp Fusion is free for typical personal/small-group usage, with a default limit of **5,000 calls per day**.
- You do **not** need to add a credit card to use the free tier.
- The key is used only for the `new` command; receipt scanning still uses Anthropic.
